import { writeFile } from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished } from "vitest";
import { persistColdLoadWarmState } from "../../../scripts/lib/control-ui-bench-warm-state.ts";
import { appendTranscriptMessages } from "../../../src/config/sessions/session-accessor.ts";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.ts";
import { cleanupSessionStateForTest } from "../../../src/test-utils/session-state-cleanup.ts";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { assertServedUi, chatControls, pairFixture } from "./chat-lifecycle.test-support.ts";
import { connectChatGateway, createChatGatewayInstance } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:completed-history-proof";
const viewport = { width: 1280, height: 900 };
const inProcessRestartMarker = "restart mode: in-process restart (OPENCLAW_NO_RESPAWN)";
const captureMedia = Boolean(process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR);
const prompt = "Compare the saved evidence.";
const reasoning = ["Check the first source.", "Compare the second source."] as const;
const commentary = "The first source is checked.";
const answer = "The saved evidence agrees.";
const draft = "Keep this unsent follow-up.";
const expectedIds = ["question", "reasoning-one", "commentary", "reasoning-two", "answer"];
const visibleOrder = [reasoning[0], commentary, reasoning[1], answer];
const text = (value: string) => ({ type: "text", text: value });
const messageId = (message: unknown) =>
  asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.id;
let instance: OpenClawTestInstance;
let client: Awaited<ReturnType<typeof connectChatGateway>>;
const suite = createControlUiE2eSuite({
  name: "Completed assistant history through a real Gateway",
  startServerBeforeBrowser: true,
  resources: {
    async run(signal) {
      client = await connectChatGateway(instance, signal);
    },
    async close() {
      await client?.stopAndWait();
    },
  },
  async startServer() {
    instance = await createChatGatewayInstance({
      name: "completed-history",
      provider: "history-fixture",
      identity: "History assistant",
      model: "unused",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "synthetic-unused-key",
      models: [{ id: "unused", name: "Unused fixture model" }],
      entrypoint: ["dist/index.js"],
      config: { update: { checkOnStart: false }, browser: { enabled: false } },
    });
    // The fixture owns this process; inherited CI supervisor hints must not transfer restart custody.
    instance.env.OPENCLAW_NO_RESPAWN = "1";
    try {
      ensureGatewayOwnerProfile("Synthetic viewer", { env: instance.env });
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close: () => instance.cleanup() };
    } catch (error) {
      return runQaGatewayFixture(
        async () => {
          throw error;
        },
        () => instance.cleanup(),
      );
    }
  },
});

suite.define(() => {
  it("restores completed history on reload without empty replies or lost drafts", async () => {
    const created = await client.request<{ sessionId: string }>("sessions.create", {
      key: sessionKey,
      agentId: "main",
      label: "Saved evidence",
    });
    await client.request("sessions.patch", { key: sessionKey, reasoningLevel: "on" });
    const assistant = (content: unknown[], stopReason = "stop") => ({
      role: "assistant",
      content,
      stopReason,
      __openclaw: { runId: "saved-evidence" },
    });
    await appendTranscriptMessages(
      { agentId: "main", sessionKey, sessionId: created.sessionId, env: instance.env },
      {
        messages: [
          { eventId: "question", message: { role: "user", content: [text(prompt)] } },
          {
            eventId: "reasoning-one",
            message: assistant([{ type: "thinking", thinking: reasoning[0] }]),
          },
          {
            eventId: "commentary",
            message: assistant([
              {
                ...text(commentary),
                textSignature: JSON.stringify({ v: 1, id: "progress-item", phase: "commentary" }),
              },
            ]),
          },
          {
            eventId: "reasoning-two",
            message: assistant([{ type: "thinking", thinking: reasoning[1] }], "length"),
          },
          ...["stop", "length"].map((stopReason) => ({
            eventId: `empty-${stopReason}`,
            message: assistant([text(""), { type: "thinking", thinking: "" }], stopReason),
          })),
          { eventId: "answer", message: assistant([text(answer)]) },
        ],
      },
    );
    // Pair before recording so the single-use handoff stays outside proof media.
    const setup = await suite.newBrowserContext({
      viewport,
      permissions: ["local-network-access"],
    });
    await pairFixture(await setup.newPage(), instance);
    const storageState = await setup.storageState();
    await suite.closeBrowserContext(setup);
    await suite.withPage(
      {
        viewport,
        storageState,
        locale: "en-US",
        colorScheme: "light",
        serviceWorkers: "block",
        permissions: ["local-network-access"],
        ...(captureMedia ? { recordVideo: { dir: suite.artifactDir, size: viewport } } : {}),
      },
      async ({ page }) => {
        // Reuse the loading fixture's passive frame boundary, retaining only history facts.
        type HistoryRead = {
          cursor: boolean;
          completed: boolean;
          ok?: boolean;
          kind?: string;
          messageCount?: number;
          hasAnswer?: boolean;
        };
        const reads: HistoryRead[] = [];
        let connections = 0;
        let connectionsBeforeRestart = 0;
        let mainFrameNavigations = 0;
        let mainFrameNavigationsBeforeRestart = 0;
        let closedSockets = 0;
        let socketErrors = 0;
        let restartAnnounced = false;
        let restartRecovered = false;
        const connectOutcomes: Array<{ ok: boolean; code?: string }> = [];
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) {
            mainFrameNavigations += 1;
          }
        });
        page.on("websocket", (socket) => {
          connections += 1;
          const connects = new Set<string>();
          const pending = new Map<string, { read: HistoryRead; subscribed: boolean }>();
          socket.on("framesent", ({ payload }) => {
            const frame = asOptionalRecord(JSON.parse(String(payload)));
            if (frame?.method === "connect" && typeof frame.id === "string") {
              connects.add(frame.id);
            }
            const params = asOptionalRecord(frame?.params);
            const subscribed = frame?.method === "sessions.messages.subscribe";
            const history = subscribed
              ? asOptionalRecord(params?.initialHistory)
              : frame?.method === "chat.startup" || frame?.method === "chat.history"
                ? params
                : undefined;
            if (
              frame?.type !== "req" ||
              typeof frame.id !== "string" ||
              !history ||
              (subscribed ? params?.key : params?.sessionKey) !== sessionKey
            ) {
              return;
            }
            const read = { cursor: typeof history.cursor === "string", completed: false };
            reads.push(read);
            pending.set(frame.id, { read, subscribed });
          });
          socket.on("framereceived", ({ payload }) => {
            const frame = asOptionalRecord(JSON.parse(String(payload)));
            if (
              frame?.type === "res" &&
              typeof frame.id === "string" &&
              connects.delete(frame.id)
            ) {
              const code = asOptionalRecord(frame.error)?.code;
              connectOutcomes.push({
                ok: frame.ok === true,
                ...(typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code) ? { code } : {}),
              });
            }
            if (
              frame?.type === "event" &&
              frame.event === "shutdown" &&
              typeof asOptionalRecord(frame.payload)?.restartExpectedMs === "number"
            ) {
              restartAnnounced = true;
            }
            const selected =
              frame?.type === "res" && typeof frame.id === "string"
                ? pending.get(frame.id)
                : undefined;
            if (!selected || !frame) {
              return;
            }
            const body = asOptionalRecord(frame.payload);
            const initial = asOptionalRecord(body?.initialHistory);
            const history = selected.subscribed ? asOptionalRecord(initial?.payload) : body;
            const messages = Array.isArray(history?.messages) ? history.messages : undefined;
            Object.assign(selected.read, {
              completed: true,
              ok: frame.ok === true && (!selected.subscribed || initial?.ok === true),
              kind: typeof history?.kind === "string" ? history.kind : "window",
              messageCount: messages?.length,
              hasAnswer: messages?.some((message) => messageId(message) === "answer"),
            });
            pending.delete(String(frame.id));
          });
          socket.on("close", () => {
            closedSockets += 1;
            pending.clear();
          });
          socket.on("socketerror", () => {
            socketErrors += 1;
          });
        });
        const observations: Array<{
          phase: string;
          ids: unknown[];
          visible: string[];
          emptyBubbles: number;
          draft: string;
          reads: HistoryRead[];
        }> = [];
        onTestFinished(async () => {
          await writeFile(
            path.join(suite.artifactDir, "history-proof.json"),
            JSON.stringify(
              {
                observations,
                reads,
                restart: {
                  connectionsBeforeRestart,
                  connections,
                  mainFrameNavigationsBeforeRestart,
                  mainFrameNavigations,
                  closedSockets,
                  socketErrors,
                  announced: restartAnnounced,
                  recovered: restartRecovered,
                  connectOutcomes: connectOutcomes.slice(-8),
                  gatewayExited: instance.child
                    ? instance.child.exitCode !== null || instance.child.signalCode !== null
                    : true,
                  exitCode: instance.child?.exitCode ?? null,
                  signalCode: instance.child?.signalCode ?? null,
                  inProcessRestart: instance.logs().includes(inProcessRestartMarker),
                },
              },
              null,
              2,
            ),
          );
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await waitForControlUiGatewayReady(page);
        await assertServedUi(page, suite.server.baseUrl);
        const { pane, composer } = chatControls(page);
        const settle = async (after: number) => {
          await pane.getByText(answer, { exact: true }).waitFor();
          await expect.poll(() => reads.slice(after).some((read) => read.completed)).toBe(true);
          await expect
            .poll(() => pane.evaluate((element) => Reflect.get(element, "transcriptReady")))
            .toBe(true);
          await pane.evaluate((element) => Reflect.get(element, "updateComplete"));
          const work = pane.locator(".chat-work-group > .chat-activity-group__summary");
          if (await work.count()) {
            await work.hover();
            if ((await work.getAttribute("aria-expanded")) !== "true") {
              await work.click();
            }
            await expect.poll(() => work.getAttribute("aria-expanded")).toBe("true");
          }
        };
        const capture = async (phase: string, after: number, screenshot: boolean) => {
          await settle(after);
          const content = (await pane.textContent()) ?? "";
          const visible: string[] = [];
          for (const label of visibleOrder) {
            if (await pane.getByText(label, { exact: true }).isVisible()) {
              visible.push(label);
            }
          }
          if (screenshot && captureMedia) {
            const frame = await takeControlUiScreenshotFrame(
              page,
              pane,
              [pane.getByText(prompt, { exact: true }), pane.getByText(answer, { exact: true })],
              { animations: "disabled" },
            );
            await writeFile(path.join(suite.artifactDir, `${phase}.png`), frame.png);
          }
          const warmInput: Parameters<typeof persistColdLoadWarmState>[0] = {
            sessionKey,
            sidebarView: "sessions",
          };
          // Sidebar persistence has its own writer; transcript settlement does not flush it.
          await page
            .locator('aside.sidebar[data-snapshot-state="live"][data-snapshot-saved="true"]')
            .waitFor();
          const warm = await page.evaluate(persistColdLoadWarmState, warmInput);
          const record = warm.storage.records.snapshots.find((entry) =>
            entry.sessionKey.endsWith(`\u0000${sessionKey}`),
          );
          if (!record) {
            throw new Error("Selected scoped snapshot was not persisted");
          }
          observations.push({
            phase,
            ids: record.snapshot.messages.map(messageId),
            visible: visible.toSorted((a, b) => content.indexOf(a) - content.indexOf(b)),
            emptyBubbles: await pane.locator('.chat-bubble[data-entry-id^="empty-"]').count(),
            draft: await composer.inputValue(),
            reads: structuredClone(reads.slice(after)),
          });
          return record;
        };
        const current = await capture("cold", 0, true);
        expect(await pane.locator('.chat-bubble[data-entry-id="answer"]').count()).toBe(1);
        expect(typeof asOptionalRecord(current.snapshot)?.deltaCursor).toBe("string");
        await composer.fill(draft);
        await composer.press("Tab");
        const stale = {
          ...current,
          projectionVersion: 12,
          snapshot: {
            ...current.snapshot,
            messages: current.snapshot.messages.filter((message) =>
              ["question", "answer"].includes(String(messageId(message))),
            ),
          },
        };
        // Preserve the real scope/session/current cursor and replace only the affected rows.
        // Unload pagehide writers before replacing one snapshot; draft/outbox stores stay owned.
        const url = page.url();
        const resetUrl = new URL("/__control-ui-bench-warm-reset__", url).href;
        await page.route(resetUrl, (route) =>
          route.fulfill({ body: "", contentType: "text/html" }),
        );
        await page.mainFrame().goto(resetUrl);
        await page.unroute(resetUrl);
        await page.evaluate(async (record) => {
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("openclaw-chat-snapshots");
            request.addEventListener("success", () => resolve(request.result));
            request.addEventListener("error", () =>
              reject(request.error ?? new Error("Snapshot open failed")),
            );
          });
          try {
            const transaction = database.transaction("snapshots", "readwrite");
            const complete = new Promise<void>((resolve, reject) => {
              transaction.addEventListener("complete", () => resolve());
              transaction.addEventListener("abort", () =>
                reject(transaction.error ?? new Error("Snapshot write failed")),
              );
            });
            transaction.objectStore("snapshots").put(record);
            await complete;
          } finally {
            database.close();
          }
        }, stale);
        const staleStart = reads.length;
        await page.goto(url);
        await waitForControlUiGatewayReady(page);
        await capture("warm-version12", staleStart, true);
        // A replacement snapshot must also survive an ordinary current-cursor reload.
        if (captureMedia) {
          await page.evaluate(() => {
            const cue = document.createElement("aside");
            cue.textContent = "Reload saved history";
            Object.assign(cue.style, {
              position: "fixed",
              right: "16px",
              top: "16px",
              zIndex: "2147483647",
              background: "#18202b",
              color: "white",
              padding: "8px 12px",
              font: "14px system-ui",
            });
            document.body.append(cue);
          });
          await page.waitForTimeout(700); // Readable cue after the settled capture.
        }
        const warmStart = reads.length;
        await page.reload();
        await waitForControlUiGatewayReady(page);
        await capture("warm-current", warmStart, false);
        if (captureMedia) {
          await page.waitForTimeout(700); // Keep the settled result legible.
        }
        for (const observation of observations) {
          expect(observation.ids, observation.phase).toEqual(expectedIds);
          expect(observation.visible, observation.phase).toEqual(visibleOrder);
          expect(observation.emptyBubbles, observation.phase).toBe(0);
          expect(observation.reads, observation.phase).toHaveLength(1);
          expect(observation.reads[0]?.ok, observation.phase).toBe(true);
          if (observation.phase !== "cold") {
            expect(observation.draft, observation.phase).toBe(draft);
          }
        }
        expect(observations[1]?.reads[0]?.cursor).toBe(false);
        expect(observations[1]?.reads[0]?.kind).toBe("window");
        expect(observations[2]?.reads[0]).toMatchObject({ cursor: true, kind: "delta" });

        // SIGUSR2 is the real CLI restart path on POSIX; Windows has no equivalent signal.
        if (process.platform !== "win32") {
          const gatewayPid = instance.child?.pid;
          if (!gatewayPid) {
            throw new Error("The isolated Gateway fixture has no running command PID");
          }
          const nodes = await Promise.all([composer.elementHandle(), pane.elementHandle()]);
          try {
            await page.evaluate(([composer, pane]) => {
              if (!composer || !pane) {
                throw new Error("The original chat view is not mounted");
              }
              Reflect.set(window, "__openclawRestartView", { document, composer, pane });
            }, nodes);
          } finally {
            await Promise.all(nodes.map((node) => node?.dispose()));
          }
          // Read from the current context: reload loses the sentinel; replacement detaches its nodes.
          const retainedViewState = () =>
            page.evaluate(() => {
              const view = Reflect.get(window, "__openclawRestartView") as
                | { document: Document; composer: Element; pane: Element }
                | undefined;
              return {
                sameDocument: view?.document === document,
                composerConnected: view?.composer.isConnected === true,
                paneConnected: view?.pane.isConnected === true,
              };
            });
          const expectedViewState = {
            sameDocument: true,
            composerConnected: true,
            paneConnected: true,
          };
          const captureRestart = async (phase: string) => {
            if (!captureMedia) {
              return;
            }
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator(".shell"),
              [composer, pane.getByText(answer, { exact: true })],
              { animations: "disabled" },
            );
            await writeFile(path.join(suite.artifactDir, `gateway-${phase}.png`), frame.png);
          };
          await captureRestart("before-restart");
          // Parent-side transcript seeds retain leases needed by restart startup maintenance.
          await cleanupSessionStateForTest({
            stateDir: instance.stateDir,
            rootPath: instance.state.root,
          });
          connectionsBeforeRestart = connections;
          mainFrameNavigationsBeforeRestart = mainFrameNavigations;
          const restartStart = reads.length;
          // Signal only the fixture command; its custody adapter owns eventual tree cleanup.
          process.kill(gatewayPid, "SIGUSR2");
          await page
            .getByRole("heading", { name: "OpenClaw is restarting", exact: true })
            .waitFor();
          expect(restartAnnounced).toBe(true);
          try {
            // Hold only transport recovery; transcript layout and real Gateway startup keep running.
            await page.context().setOffline(true);
            expect(await retainedViewState()).toEqual(expectedViewState);
            expect(await composer.inputValue()).toBe(draft);
            await pane.getByText(answer, { exact: true }).waitFor({ state: "visible" });
            await captureRestart("restarting");
          } finally {
            await page.context().setOffline(false);
          }

          await expect.poll(() => connections).toBeGreaterThan(connectionsBeforeRestart);
          await waitForControlUiGatewayReady(page);
          await settle(restartStart);
          expect(instance.child?.pid).toBe(gatewayPid);
          expect(instance.child?.exitCode).toBeNull();
          expect(instance.child?.signalCode).toBeNull();
          expect(instance.logs().includes(inProcessRestartMarker)).toBe(true);
          await page.locator(".gateway-holding-notice").waitFor({ state: "detached" });
          expect(await retainedViewState()).toEqual(expectedViewState);
          expect(await composer.inputValue()).toBe(draft);
          expect(await pane.locator('.chat-bubble[data-entry-id="answer"]').count()).toBe(1);
          restartRecovered = true;
          await captureRestart("recovered");
        }
      },
      async ({ page, context }) => {
        const video = page.video();
        await suite.closeBrowserContext(context);
        if (captureMedia) {
          await video?.saveAs(path.join(suite.artifactDir, "history-reload.webm"));
        }
      },
    );
  });
});

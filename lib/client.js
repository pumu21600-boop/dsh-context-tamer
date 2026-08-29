/**
 * dsh-context-tamer — client half (0.1.0).
 *
 * A composer-dock chip that shows the live context-size estimate (host
 * projection `contextTamer`) colored against the configured threshold, with
 * a popover: stats, threshold editor, and a one-click HANDOFF action that
 * injects a structured handover prompt into the composer
 * (inputActions.setDraft) so the model writes docs/HANDOFF.md while its
 * memory is freshest.
 * values round-trip through the host endpoint (host settings.yaml).
 */
window.__ModuleLoader__.load({
	id: "dsh-context-tamer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const { jsx, jsxs, Fragment } = jsxRuntime;
		const reactDom = require("react-dom");
		const createPortal = reactDom.createPortal;

		const NS = "context-tamer";
		const CSS_NS = "ct";
		const DEFAULT_THRESHOLD = 150000;

		/* ── config store (host endpoint ↔ host settings.yaml) ─────────── */
		let configState = { threshold: DEFAULT_THRESHOLD, autoCommit: false, loaded: false, error: "" };
		const configSubs = /* @__PURE__ */ new Set();
		const configStore = {
			getSnapshot: () => configState,
			subscribe: (fn) => {
				configSubs.add(fn);
				return () => configSubs.delete(fn);
			},
			set: (next) => {
				configState = next;
				for (const fn of [...configSubs]) fn();
			},
		};
		async function loadConfig() {
			try {
				const r = await fetch("/dsh-context-tamer/config", { headers: { accept: "application/json" } });
				const d = await r.json();
				if (!r.ok || !d || d.ok !== true) throw new Error((d && d.reason) || "HTTP " + r.status);
				const t = Number(d.threshold);
				configStore.set({
					threshold: Number.isFinite(t) && t > 0 ? t : DEFAULT_THRESHOLD,
					autoCommit: d.autoCommit === true,
					loaded: true,
					error: "",
				});
			} catch (err) {
				configStore.set({ ...configStore.getSnapshot(), loaded: true, error: String(err?.message ?? err) });
			}
		}
		async function saveConfig(patch) {
			const r = await fetch("/dsh-context-tamer/config", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(patch),
			});
			const d = await r.json();
			if (!r.ok || !d || d.ok !== true) throw new Error((d && d.reason) || "HTTP " + r.status);
			const snap = configStore.getSnapshot();
			configStore.set({
				threshold: d.threshold !== undefined ? Number(d.threshold) : snap.threshold,
				autoCommit: d.autoCommit !== undefined ? d.autoCommit === true : snap.autoCommit,
				loaded: true,
				error: "",
			});
		}

		/* ── formatting / helpers ─────────────────────────────────────── */
		function fmtTokens(n) {
			const v = Number(n);
			if (!Number.isFinite(v)) return "—";
			if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
			if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
			if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
			return String(Math.round(v));
		}
		function fmtNum(n) {
			const v = Number(n);
			return Number.isFinite(v) ? String(Math.round(v)) : "—";
		}
		function ratioOf(proj, threshold) {
			if (!proj || !Number.isFinite(Number(proj.lastContextTokens))) return 0;
			return Number(proj.lastContextTokens) / Math.max(1, Number(threshold));
		}
		function bandOf(ratio) {
			if (ratio >= 1) return "over";
			if (ratio >= 0.6) return "warn";
			return "ok";
		}
		/* ── styles ───────────────────────────────────────────────────── */
		/* Neutral gray, theme-adaptive via light-dark(): DSH sets
		   `color-scheme` on <html> per active theme, so the chip/popover
		   flip light ↔ dark automatically. Status colors (green/amber/red)
		   stay for the budget dot and hints only. */
		const css = `.${CSS_NS}_root{align-items:center;gap:6px;display:inline-flex}
.${CSS_NS}_chip{box-sizing:border-box;height:22px;cursor:pointer;color:light-dark(#374151,#d1d5db);background:light-dark(#ffffff,#262626);border:1px solid light-dark(#cbd5e1,#525252);border-radius:11px;align-items:center;gap:5px;padding:0 10px;font-size:12px;line-height:18px;display:inline-flex;font-variant-numeric:tabular-nums}
.${CSS_NS}_chip:hover{color:light-dark(#111827,#f9fafb);border-color:light-dark(#111827,#d1d5db);background:light-dark(#f3f4f6,#2f2f2f)}
.${CSS_NS}_chip[data-open="true"]{color:light-dark(#111827,#f9fafb);border-color:light-dark(#111827,#d1d5db);background:light-dark(#f3f4f6,#2f2f2f)}
.${CSS_NS}_dot{width:6px;height:6px;border-radius:50%;flex:none}
.${CSS_NS}_dotOk{background:light-dark(#16a34a,#4ade80)}
.${CSS_NS}_dotWarn{background:light-dark(#d97706,#f5a623)}
.${CSS_NS}_dotOver{background:light-dark(#dc2626,#f87171)}
.${CSS_NS}_dotPulse{animation:${CSS_NS}_pulse 1.6s ease-in-out infinite}
@keyframes ${CSS_NS}_pulse{0%,100%{opacity:1}50%{opacity:.35}}
.${CSS_NS}_badge{color:#dc2626;font-weight:600}
.${CSS_NS}_pop{position:fixed;z-index:2147483000;transform:translateY(-100%);width:360px;max-width:calc(100vw - 24px);max-height:70vh;overflow:auto;box-sizing:border-box;background:light-dark(#ffffff,#1f1f1f);border:1px solid light-dark(#cbd5e1,#4b5563);border-radius:12px;box-shadow:0 14px 44px light-dark(rgba(17,24,39,.18),rgba(0,0,0,.55));padding:12px 14px;color:light-dark(#374151,#d1d5db);font:12px/1.6 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
.${CSS_NS}_head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.${CSS_NS}_title{font:600 13px/1.5 ui-monospace,Consolas,monospace;color:light-dark(#111827,#f3f4f6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${CSS_NS}_big{font:600 15px/1.5 ui-monospace,Consolas,monospace;color:light-dark(#111827,#f3f4f6);flex:none}
.${CSS_NS}_row{display:flex;align-items:baseline;gap:8px;padding:4px 0;border-top:1px solid light-dark(#e5e7eb,#3f3f46)}
.${CSS_NS}_k{flex:none;width:118px;color:light-dark(#6b7280,#9ca3af);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${CSS_NS}_v{flex:1;text-align:right;color:light-dark(#374151,#d1d5db);font-variant-numeric:tabular-nums;font:11px/1.6 ui-monospace,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${CSS_NS}_hint{color:light-dark(#6b7280,#9ca3af);font-size:11px;margin-top:8px;border-top:1px solid light-dark(#e5e7eb,#3f3f46);padding-top:6px}
.${CSS_NS}_hintWarn{color:#b45309;font-size:11px;margin-top:8px;border-top:1px solid light-dark(#e5e7eb,#3f3f46);padding-top:6px}
.${CSS_NS}_hintOver{color:#dc2626;font-size:11px;margin-top:8px;border-top:1px solid light-dark(#e5e7eb,#3f3f46);padding-top:6px}
.${CSS_NS}_btns{display:flex;gap:8px;margin-top:10px}
.${CSS_NS}_btn{box-sizing:border-box;height:28px;flex:none;cursor:pointer;color:light-dark(#374151,#e5e7eb);background:transparent;border:1px solid light-dark(#9ca3af,#525252);border-radius:14px;padding:0 12px;font:inherit;font-size:12px;line-height:18px}
.${CSS_NS}_btn:hover{background:light-dark(rgba(17,24,39,.06),rgba(255,255,255,.08));border-color:light-dark(#111827,#d1d5db)}
.${CSS_NS}_btnOn{color:light-dark(#ffffff,#111111);background:light-dark(#111827,#e5e7eb);border-color:light-dark(#111827,#e5e7eb)}
.${CSS_NS}_thrRow{align-items:center;gap:8px;display:flex;margin-top:10px;border-top:1px solid light-dark(#e5e7eb,#3f3f46);padding-top:8px}
.${CSS_NS}_lbl{color:inherit;opacity:.8;font-size:12px;line-height:18px;flex:none}
.${CSS_NS}_inp{box-sizing:border-box;color:light-dark(#111827,#e5e7eb);background:transparent;border:1px solid light-dark(#9ca3af,#525252);border-radius:9px;padding:4px 8px;font:inherit;font-size:12px;line-height:18px;outline:none;width:110px;flex:none}
.${CSS_NS}_inp:focus{border-color:light-dark(#111827,#d1d5db)}
.${CSS_NS}_err{color:#dc2626;font-size:11px;margin-top:4px}
.${CSS_NS}_section{flex-direction:column;gap:12px;width:100%;display:flex}
.${CSS_NS}_section .${CSS_NS}_hint{margin-top:0;border-top:none;padding-top:0;color:inherit;opacity:.75;font-size:12px;line-height:18px}
.${CSS_NS}_saved{color:light-dark(#374151,#d1d5db);font-size:11px}`;
		const tagId = "dsh-context-tamer/context.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-context-tamer";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/* ── popover hook (anchored above the chip) ───────────────────── */
		function usePopover() {
			const chipRef = react.useRef(null);
			const [open, setOpen] = react.useState(false);
			const [pos, setPos] = react.useState({ left: 0, top: 0 });
			react.useEffect(() => {
				if (!open) return;
				const onDocClick = (ev) => {
					if (chipRef.current && chipRef.current.contains(ev.target)) return;
					const pop = document.getElementById("dsh-context-tamer-pop");
					if (pop && pop.contains(ev.target)) return;
					setOpen(false);
				};
				const onKey = (ev) => {
					if (ev.key === "Escape") setOpen(false);
				};
				document.addEventListener("click", onDocClick, true);
				document.addEventListener("keydown", onKey, true);
				return () => {
					document.removeEventListener("click", onDocClick, true);
					document.removeEventListener("keydown", onKey, true);
				};
			}, [open]);
			const toggle = () => {
				if (open) {
					setOpen(false);
					return;
				}
				const r = chipRef.current?.getBoundingClientRect();
				if (!r) return;
				const w = 360;
				let left = r.left;
				if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
				setPos({ left, top: r.top - 6 });
				setOpen(true);
			};
			return { chipRef, open, pos, toggle, setOpen };
		}

		/* ── one-click continue state ─────────────────────────────────── */
		const NO_SESSION = "\u0000none";
		let pendingFromId = null;
		let pendingTargetId = null; // exact new session id (null → change detection)
		let pendingExpectedCwd = null; // normalized cwd the new session must land in
		let pendingHandoffFile = null;
		const normPath = (p) => (typeof p === "string" ? p.replace(/\\/g, "/").toLowerCase() : null);
		const disarmSwitch = () => {
			pendingFromId = null;
			pendingTargetId = null;
			pendingExpectedCwd = null;
			pendingHandoffFile = null;
		};

		/* ── debug reporting → host /dsh-context-tamer/client-log ───────
		   Gated behind DEBUG; production builds ship with it off so the
		   continue flow makes zero extra network calls. */
		const DEBUG = false;
		function clog(event, data) {
			if (!DEBUG) return;
			try {
				void fetch("/dsh-context-tamer/client-log", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ event, data }),
				});
			} catch {}
		}

		/* ── composer-dock chip ───────────────────────────────────────── */
		function ContextLine({ useProjection, t, sessions, workspaces, sessionId, inputActions }) {
			const proj = useProjection("contextTamer");
			const snap = react.useSyncExternalStore(configStore.subscribe, configStore.getSnapshot);
			const { chipRef, open, pos, toggle, setOpen } = usePopover();
			const [thrDraft, setThrDraft] = react.useState("");
			const [saveMsg, setSaveMsg] = react.useState("");
			const [saveErr, setSaveErr] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			// Latest inputActions for the fire-retry (props captured in the
			// effect closure go stale across the session transition).
			const iaRef = react.useRef(null);
			iaRef.current = inputActions;

			// Fire-and-forget continuation: inject the seed prompt (explicitly
			// citing the handoff file minted for the source session) ONLY when
			// the current session is exactly the intended target — a failed or
			// superseded switch can never spray the draft into the wrong
			// conversation. Then STOP: the user types their next request.
			react.useEffect(() => {
				if (pendingFromId === null) return;
				const cur = sessionId;
				clog("effect", { cur: cur ?? null, target: pendingTargetId, from: pendingFromId });
				const fire = () => {
					const file = pendingHandoffFile;
					disarmSwitch();
					setBusy(false);
					const attempt = () => {
						const ia = iaRef.current;
						try {
							if (ia && typeof ia.setDraft === "function") {
								ia.setDraft(file ? t("continue.prompt", { file }) : t("continue.promptNoFile"));
								clog("fire-setdraft", { file: file || null });
								return true;
							}
						} catch (err) {
							clog("fire-setdraft-error", { err: String(err?.message ?? err) });
						}
						return false;
					};
					clog("fire", { file: file || null, hasIA: !!(iaRef.current && typeof iaRef.current.setDraft === "function") });
					// Defer one tick so a session-transition render has committed
					// the NEW session's inputActions into iaRef before writing.
					setTimeout(() => {
						if (!attempt()) {
							setTimeout(() => {
								if (!attempt()) setTimeout(() => attempt(), 600);
							}, 400);
						}
					}, 120);
				};
				if (pendingTargetId !== null) {
					// Exact-target path: fire only on the precise new session.
					if (cur === pendingTargetId) return fire();
					// Transitional state (cur undefined while the fresh session's
					// scope mounts) must NOT be treated as "navigated elsewhere".
					if (cur !== undefined && cur !== pendingFromId && cur !== pendingTargetId) {
						// Landed on some other session: acceptable ONLY if it is a
						// blank conversation in the same project (the app may have
						// reordered blanks); otherwise keep the arm and let the
						// navigation re-assert win, with the giveup as backstop.
						let altOk = false;
						try {
							const snap = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
							const row = snap && snap.byId ? snap.byId[cur] : null;
							const rcwd = row ? normPath(row.cwd) : null;
							altOk = !!(row && row.blank === true && (!pendingExpectedCwd || rcwd === null || rcwd === pendingExpectedCwd));
						} catch {}
						clog("landed-elsewhere", {
							cur: cur ?? null,
							altOk,
							listCurrent: ((sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot().current : null) ?? null),
						});
						if (altOk) return fire();
						// keep waiting for the re-assert
					}
				} else if (cur !== undefined && cur !== pendingFromId) {
					// Change-detection path (fallback switch): verify the landing
					// session's cwd matches the expected project before firing.
					let ok = true;
					if (pendingExpectedCwd) {
						let curCwd = null;
						try {
							const snap = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
							curCwd = (snap && snap.byId && snap.byId[cur] && snap.byId[cur].cwd) || null;
						} catch {}
						const nc = normPath(curCwd);
						// Unknown cwd (summary not yet carrying the host frame) is
						// not a mismatch — only a known, different cwd aborts.
						ok = nc === null || nc === pendingExpectedCwd;
						clog("cwd-verify", { curCwd: curCwd ?? null, expected: pendingExpectedCwd, ok });
					}
					if (ok) return fire();
					clog("disarm", { reason: "cwd-mismatch", cur: cur ?? null });
					disarmSwitch();
					setBusy(false);
					return;
				} else {
					// Same session still current: only fire if it is (or became) a
					// blank conversation — the blank-reuse switch keeps the id.
					const blankTimer = setTimeout(() => {
						if (pendingFromId === null) return;
						let isBlank = false;
						try {
							const snap = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
							isBlank = !!(snap && snap.byId && snap.byId[cur] && snap.byId[cur].blank === true);
						} catch {}
						clog("blank-check", { cur: cur ?? null, isBlank });
						if (isBlank && cur !== undefined) fire();
					}, 1200);
					const giveup = setTimeout(() => {
						if (pendingFromId !== null) {
							clog("disarm", { reason: "giveup" });
							disarmSwitch();
							setBusy(false);
						}
					}, 10000);
					return () => {
						clearTimeout(blankTimer);
						clearTimeout(giveup);
					};
				}
				const giveup = setTimeout(() => {
					if (pendingFromId !== null) {
						clog("disarm", { reason: "giveup-target" });
						disarmSwitch();
						setBusy(false);
					}
				}, 10000);
				return () => clearTimeout(giveup);
			}, [sessionId]);

			const tokens = proj ? Number(proj.lastContextTokens) : 0;
			const ratio = ratioOf(proj, snap.threshold);
			const band = bandOf(ratio);
			const dotCls =
				CSS_NS + "_dot " +
				(band === "over" ? CSS_NS + "_dotOver" : band === "warn" ? CSS_NS + "_dotWarn" : CSS_NS + "_dotOk") +
				(band === "over" ? " " + CSS_NS + "_dotPulse" : "");

			const onContinue = async () => {
				if (busy) return;
				setBusy(true);
				try {
					disarmSwitch();
					// Arm first: whichever path wins, the injection effect fires
					// only on the exact target session (or a cwd-verified one).
					pendingFromId = sessionId ?? NO_SESSION;
					const cur = sessionId;
					let started = false;
					clog("continue-click", { cur: cur ?? null });

					// Host mints/refreshes THIS session's handoff and returns its
					// absolute path + authoritative cwd. The injected prompt then
					// cites that exact file, so the wrong project's handoff can
					// never leak in — regardless of how workspaces are grouped.
					let cwd = null;
					if (cur !== undefined) {
						try {
							const r = await fetch("/dsh-context-tamer/continue", {
								method: "POST",
								headers: { "content-type": "application/json", accept: "application/json" },
								body: JSON.stringify({ sessionId: cur }),
							});
							const d = await r.json();
							if (r.ok && d && d.ok === true && typeof d.cwd === "string" && d.cwd !== "") cwd = d.cwd;
							if (r.ok && d && d.ok === true && typeof d.handoffFile === "string" && d.handoffFile !== "") pendingHandoffFile = d.handoffFile;
							clog("continue-host", { ok: r.ok, cwd: cwd || null, file: pendingHandoffFile || null });
						} catch (err) {
							clog("continue-host-fetch-error", { err: String(err?.message ?? err) });
						}
					}
					if (cwd) pendingExpectedCwd = normPath(cwd);

					// Settle: the host has already generated the handoff
					// synchronously inside /continue (the response only arrives
					// after the file is written), but a short pause lets the
					// fresh excerpt land in the index before we switch away.
					await new Promise((resolve) => setTimeout(resolve, 800));
					clog("continue-settled", {});

					// Path 1 (primary): a workspace containing the current session
					// — or one whose path equals the authoritative cwd — connects
					// through connectWorkspace (reuses the workspace's attached
					// blank session, so the hero phase shows the project title and
					// the composer machine is live for the draft injection).
					let wsId = null;
					if (!started && workspaces && typeof workspaces.connectWorkspace === "function") {
						try {
							const snap = workspaces.list && workspaces.list.getSnapshot ? workspaces.list.getSnapshot() : null;
							const items = snap && Array.isArray(snap.items) ? snap.items : [];
							const byCur = items.find((w) => w && Array.isArray(w.sessionIds) && w.sessionIds.includes(cur));
							const byPath = !byCur && pendingExpectedCwd
								? items.find((w) => w && normPath(w.path) === pendingExpectedCwd)
								: undefined;
							wsId = (byCur ?? byPath ?? {}).workspaceId ?? null;
							clog("path1-lookup", { hasConnect: true, items: items.length, wsId: wsId || null });
						} catch (err) {
							clog("path1-lookup-error", { err: String(err?.message ?? err) });
						}
					} else if (!started) {
						clog("path1-lookup", { hasConnect: false });
					}
					if (wsId && !started) {
						try {
							const sid = await workspaces.connectWorkspace(wsId);
							pendingTargetId = typeof sid === "string" ? sid : null;
							clog("path1-connected", { wsId, sid: pendingTargetId || null });
							if (pendingTargetId && typeof sessions?.open === "function") sessions.open(pendingTargetId);
							started = true;
						} catch (err) {
							clog("path1-error", { err: String(err?.message ?? err) });
							/* fall through to direct create */
						}
					}

					// Path 2 (fallback): authoritative cwd → create the session
					// directly against that directory.
					if (!started && cwd && typeof sessions?.create === "function") {
						try {
							const created = await sessions.create({ cwd });
							const sid = typeof created === "string" ? created : created?.sessionId;
							if (!sid) throw new Error("no session id");
							pendingTargetId = sid;
							clog("path2-created", { cwd, sid });
							if (typeof sessions?.open === "function") sessions.open(sid);
							started = true;
						} catch (err) {
							clog("path2-error", { err: String(err?.message ?? err) });
							/* fall through to last resort */
						}
					}

					// Path 3: last resort — plain startSession() / create();
					// change detection with cwd verification guards the injection.
					if (!started && workspaces && typeof workspaces.startSession === "function") {
						clog("path3-startSession", {});
						workspaces.startSession();
						started = true;
					} else if (!started && typeof sessions?.create === "function" && typeof sessions?.open === "function") {
						clog("path3-create", {});
						void sessions.create({})
							.then((created) => {
								const id = typeof created === "string" ? created : created?.sessionId;
								if (!id) throw new Error("no session id");
								sessions.open(id);
							})
							.catch((err) => {
								clog("path3-create-error", { err: String(err?.message ?? err) });
								disarmSwitch();
								setBusy(false);
								setSaveErr(String(err?.message ?? err));
							});
						started = true;
					}

					if (!started) throw new Error("no session switch available");

					// Navigation re-assert: DSH can re-select another session a
					// moment after open() (blank-reorder races observed in the
					// wild). Re-assert the target a few times; the effect only
					// fires once the view actually lands on it (or on a same-
					// project blank), so a losing race can never misfire.
					if (pendingTargetId !== null) {
						for (const delay of [300, 900, 1800]) {
							setTimeout(() => {
								if (pendingFromId === null || pendingTargetId === null) return;
								try {
									const snap = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
									const current = snap ? snap.current : undefined;
									clog("reassert", { current: current ?? null, target: pendingTargetId });
									if (current !== pendingTargetId && typeof sessions?.open === "function") sessions.open(pendingTargetId);
								} catch (err) {
									clog("reassert-error", { err: String(err?.message ?? err) });
								}
							}, delay);
						}
					}
					setOpen(false);
				} catch (err) {
					clog("continue-error", { err: String(err?.message ?? err) });
					disarmSwitch();
					setBusy(false);
					setSaveErr(String(err?.message ?? err));
				}
			};

			const onSaveThreshold = async () => {
				const v = Number(thrDraft);
				if (!Number.isFinite(v) || v < 1000 || v > 100000000) {
					setSaveErr(t("threshold.err"));
					return;
				}
				setSaveErr("");
				try {
					await saveConfig({ threshold: Math.round(v) });
					setSaveMsg(t("threshold.saved"));
					setTimeout(() => setSaveMsg(""), 1600);
				} catch (err) {
					setSaveErr(String(err?.message ?? err));
				}
			};

			const hint = band === "over" ? t("over.hint") : band === "warn" ? t("warn.hint") : t("ok.hint");
			const hintCls = band === "over" ? CSS_NS + "_hintOver" : band === "warn" ? CSS_NS + "_hintWarn" : CSS_NS + "_hint";

			const pop = open
				? createPortal(
						jsxs("div", {
							id: "dsh-context-tamer-pop",
							className: CSS_NS + "_pop",
							style: { left: pos.left + "px", top: pos.top + "px" },
							children: [
								jsxs("div", {
									className: CSS_NS + "_head",
									children: [
										jsx("div", { className: CSS_NS + "_title", children: t("pop.title") }),
										jsx("div", { className: CSS_NS + "_big", children: fmtTokens(tokens) }),
									],
								}),
								jsxs("div", { className: CSS_NS + "_row", children: [
									jsx("span", { className: CSS_NS + "_k", children: t("stat.peak") }),
									jsx("span", { className: CSS_NS + "_v", children: fmtTokens(proj?.peakContextTokens) }),
								] }),
								jsxs("div", { className: CSS_NS + "_row", children: [
									jsx("span", { className: CSS_NS + "_k", children: t("stat.turns") }),
									jsx("span", { className: CSS_NS + "_v", children: fmtNum(proj?.turns) }),
								] }),
								jsxs("div", { className: CSS_NS + "_row", children: [
									jsx("span", { className: CSS_NS + "_k", children: t("stat.messages") }),
									jsx("span", { className: CSS_NS + "_v", children: fmtNum(proj ? (proj.userMessages ?? 0) + (proj.assistantMessages ?? 0) : 0) }),
								] }),
								jsxs("div", { className: CSS_NS + "_row", children: [
									jsx("span", { className: CSS_NS + "_k", children: t("stat.tools") }),
									jsx("span", { className: CSS_NS + "_v", children: fmtNum(proj?.toolEvents) }),
								] }),
								jsxs("div", { className: CSS_NS + "_row", children: [
									jsx("span", { className: CSS_NS + "_k", children: t("stat.cache") }),
									jsx("span", { className: CSS_NS + "_v", children: `${fmtTokens(proj?.lastCacheReadTokens)} / ${fmtTokens(proj?.lastCacheWriteTokens)}` }),
								] }),
								jsxs("div", { className: CSS_NS + "_row", children: [
									jsx("span", { className: CSS_NS + "_k", children: t("stat.output") }),
									jsx("span", { className: CSS_NS + "_v", children: fmtTokens(proj?.lastOutputTokens) }),
								] }),
								proj && (proj.lastModel || proj.lastProvider)
									? jsxs("div", { className: CSS_NS + "_row", children: [
											jsx("span", { className: CSS_NS + "_k", children: t("stat.model") }),
											jsx("span", { className: CSS_NS + "_v", children: (proj.lastProvider ? proj.lastProvider + " / " : "") + (proj.lastModel ?? "") }),
										] })
									: null,
								jsxs("div", {
									className: CSS_NS + "_thrRow",
									children: [
										jsx("span", { className: CSS_NS + "_lbl", children: t("threshold.label") }),
										jsx("input", {
											className: CSS_NS + "_inp",
											type: "number",
											min: "1000",
											step: "1000",
											value: thrDraft === "" ? String(snap.threshold) : thrDraft,
											onChange: (e) => setThrDraft(e.target.value),
										}),
										jsx("button", {
											type: "button",
											className: CSS_NS + "_btn",
											onClick: onSaveThreshold,
											children: t("threshold.save"),
										}),
									],
								}),
								saveMsg !== "" && jsx("div", { className: CSS_NS + "_saved", children: saveMsg }),
								saveErr !== "" && jsx("div", { className: CSS_NS + "_err", children: saveErr }),
								jsxs("div", {
									className: CSS_NS + "_btns",
									children: [
										jsx("button", {
											type: "button",
											className: CSS_NS + "_btn " + CSS_NS + "_btnOn",
											disabled: busy,
											onClick: onContinue,
											children: busy ? t("btn.continueBusy") : t("btn.continue"),
										}),
									],
								}),
								jsx("div", { className: CSS_NS + "_saved", children: t("auto.hint") }),
								jsx("div", { className: hintCls, children: hint }),
							],
						}),
						document.body,
					)
				: null;

			return jsxs(Fragment, {
				children: [
					jsxs("button", {
						ref: chipRef,
						type: "button",
						title: t("chip.title"),
						"data-open": open ? "true" : void 0,
						className: CSS_NS + "_chip",
						onClick: toggle,
						children: [
							jsx("span", { className: dotCls }),
							jsx("span", { children: t("chip.context") + " " + (proj ? fmtTokens(tokens) : "—") }),
						],
					}),
					pop,
				],
			});
		}

		/* ── locale dictionaries ──────────────────────────────────────── */
		const zh = {
			"chip.title": "上下文长度与交接工具",
			"chip.context": "上下文",
			"pop.title": "上下文预算",
			"stat.context": "当前上下文",
			"stat.peak": "峰值",
			"stat.turns": "轮次",
			"stat.messages": "消息",
			"stat.tools": "工具事件",
			"stat.cache": "缓存读/写",
			"stat.output": "最近输出",
			"stat.model": "最近模型",
			"threshold.label": "阈值 (tokens)",
			"threshold.save": "保存",
			"threshold.saved": "已保存",
			"threshold.err": "阈值须在 1000 ~ 1 亿之间",
			"btn.continue": "继续 → 无感切换",
			"btn.continueBusy": "切换中…",
			"continue.prompt": "继续项目。交接文件：{file} —— 先读取该文件，用 3~5 行复述当前进度与下一步待办，然后等我给出具体任务。",
			"continue.promptNoFile": "继续项目。请先说明你掌握的项目背景与进度，然后等我给出具体任务。",
			"ok.hint": "空间充足。交接文件每轮自动保鲜，无需手动操作。",
			"warn.hint": "接近阈值：交接文件已自动保鲜，随时可安全重开会话。",
			"over.hint": "已超阈值：交接文件已自动保鲜——直接开新会话说“继续”即可，每轮可省约 97% 输入成本。",
			"auto.hint": "✓ 交接文件自动保鲜于 ~/.dsh/storages/handoffs/，新会话自动读取，无需任何手动操作。",
		};
		const en = {
			"chip.title": "Context size & handover tool",
			"chip.context": "Context",
			"pop.title": "Context budget",
			"stat.context": "Current context",
			"stat.peak": "Peak",
			"stat.turns": "Turns",
			"stat.messages": "Messages",
			"stat.tools": "Tool events",
			"stat.cache": "Cache read/write",
			"stat.output": "Last output",
			"stat.model": "Last model",
			"threshold.label": "Threshold (tokens)",
			"threshold.save": "Save",
			"threshold.saved": "Saved",
			"threshold.err": "Threshold must be 1000 ~ 100M",
			"btn.continue": "Continue → seamless switch",
			"btn.continueBusy": "Switching…",
			"continue.prompt": "Continue the project. Handoff file: {file} — read it first, restate current progress and next steps in 3-5 lines, then wait for my concrete task.",
			"continue.promptNoFile": "Continue the project. First state what you know about this project's background and progress, then wait for my concrete task.",
			"ok.hint": "Plenty of headroom. The handoff file refreshes automatically every turn.",
			"warn.hint": "Near threshold: the handoff file is already fresh — restart anytime.",
			"over.hint": "Over threshold: handoff is already fresh — just open a new conversation and say \"continue\" (~97% cheaper per turn).",
			"auto.hint": "✓ Handoff auto-refreshes under ~/.dsh/storages/handoffs/; new conversations read it automatically. Nothing to do manually.",
		};

		/* ── plugin body ──────────────────────────────────────────────── */
		const inject = ["slots", "locale", "sessions", "workspaces"];

		/* Hero-phase variant: `conversation.composer.dock` does NOT render
		   while the current session is blank (DSH shows the hero screen), so
		   the continuation seed prompt would never reach the draft. This
		   wrapper rides `conversation.input.dock` — the full-width row that
		   DOES render above the composer in hero phase — and shows the chip
		   only while the session is blank; active sessions keep the dock chip
		   below the card (no duplicate). */
		function HeroLine(props) {
			// Reactive blank check: subscribes to the session list store so the
			// chip appears/disappears the moment the session flips blank→active.
			let blank = false;
			try {
				const list = props.sessions && props.sessions.list;
				const snap = list && typeof list.getSnapshot === "function"
					? react.useSyncExternalStore(list.subscribe, list.getSnapshot)
					: list.getSnapshot();
				blank = !!(props.sessionId && snap && snap.byId && snap.byId[props.sessionId] && snap.byId[props.sessionId].blank === true);
			} catch {}
			return blank ? jsx(ContextLine, props) : null;
		}

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-context-tamer: dict");
			void loadConfig();

			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register(
					{ name: "conversation.composer.dock", id: "context-tamer", order: 2, locale: NS, inject: () => ({ sessions: ctx.sessions, workspaces: ctx.workspaces }) },
					ContextLine,
				),
			);

			ctx.slots.inject("conversation.input.dock", () =>
				ctx.slots.register(
					{ name: "conversation.input.dock", id: "context-tamer-hero", order: 50, locale: NS, inject: () => ({ sessions: ctx.sessions, workspaces: ctx.workspaces }) },
					HeroLine,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});

#!/usr/bin/env node
/**
 * memorixCursorPatch.mjs —— 给裁剪版 Memorix CLI 补 cursor 通道的续接简报。
 * 上游 buildClaudeContinuationPromptContext 只在 agent==="claude" 时生成前情;
 * Cursor 钩子按接入约定传 --agent cursor,正例因此整段不注。
 * 本补丁不改调用方的 --agent:仍是 cursor。cursor 的续接正例注入简报正文(context.prompt);
 * claude 通道维持原 hasContinuation 门槛。另在 cursor 分支补三处捕获(claude 的 normalizeClaude 不动):
 *   afterFileEdit 把 edits/old_content 写入 edits;afterMCPExecution 读 tool 字段;
 *   afterAgentResponse 映成 post_response 并读 text;该事件对 cursor 走 admission,不 always 入库。
 * --event 对 cursor 生效(extractEventName 先读 _memorix_event)。stage/init 重装会重打,幂等。
 */
import fs from 'node:fs';

export const GATE_OLD = 'if (input.agent !== "claude" || input.event !== "user_prompt" || !input.userPrompt?.trim())';
export const GATE_NEW = 'if ((input.agent !== "claude" && input.agent !== "cursor") || input.event !== "user_prompt" || !input.userPrompt?.trim())';

export const BLOCK_OLD = `  if (continuationRequested) {
    const context = await buildHookProjectContext(input, input.userPrompt, "hook-user-prompt");
    if (context?.hasContinuation) {
      return [
        "Memorix prepared a bounded prior-work brief for this explicit continuation request.",
        "Treat it as background context; current code wins. Use it before broad Git or file-history archaeology.",
        "",
        context.prompt
      ].join("\\n");
    }
  }
  if (continuationRequested || resolveTaskLens2(input.userPrompt).id === "onboarding") {
    return [
      "Memorix is available for this handoff or continuation.",
      "Before broad file or Git exploration, call memorix_project_context with the user's actual task.",
      "If it is not visible yet, use Claude Code tool search for memorix_project_context; use CLI only when MCP discovery is unavailable."
    ].join(" ");
  }`;

export const BLOCK_NEW = `  if (continuationRequested) {
    const context = await buildHookProjectContext(input, input.userPrompt, "hook-user-prompt");
    if (input.agent === "cursor" && context?.prompt?.trim()) {
      return [
        "Memorix prepared a bounded prior-work brief for this continuation request.",
        "Treat it as background context; current code wins. Use it before broad Git or file-history archaeology.",
        "",
        context.prompt
      ].join("\\n");
    }
    if (context?.hasContinuation) {
      return [
        "Memorix prepared a bounded prior-work brief for this explicit continuation request.",
        "Treat it as background context; current code wins. Use it before broad Git or file-history archaeology.",
        "",
        context.prompt
      ].join("\\n");
    }
  }
  if (continuationRequested || resolveTaskLens2(input.userPrompt).id === "onboarding") {
    return [
      "Memorix is available for this handoff or continuation.",
      "Before broad file or Git exploration, call memorix_project_context with the user's actual task.",
      input.agent === "cursor"
        ? "If it is not visible yet, call memorix_project_context through the Cursor MCP server; use the CLI only when MCP discovery is unavailable."
        : "If it is not visible yet, use Claude Code tool search for memorix_project_context; use CLI only when MCP discovery is unavailable."
    ].join(" ");
  }`;

/** post_tool 入参:Cursor 的 tool_input 是 JSON 参数字符串(官方文档),原样塞给 toolInput 时上游
 *  extractContent 只认对象、不读 query/file_path → 记忆正文只有返回值。字符串先解析成对象;
 *  解析不出对象(非法 JSON/标量/数组)保留原串。 */
export const POST_TOOL_NOW = `      result.toolName = payload.tool_name ?? payload.mcp_tool_name ?? payload.mcp_server_name ?? "";
      let toolInput = payload.tool_input ?? payload.mcp_tool_input;
      if (typeof toolInput === "string") {
        try {
          const parsed = JSON.parse(toolInput);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) toolInput = parsed;
        } catch {
          // 非法 JSON:保留原串
        }
      }
      result.toolInput = toolInput;`;
/** 过渡期形态(2026-11-26 首版捕获补丁,已打在本机 vendor/staged 上):认得并升级到 POST_TOOL_NOW。 */
export const POST_TOOL_PREV = `      result.toolName = payload.tool_name ?? payload.mcp_tool_name ?? payload.mcp_server_name ?? "";
      result.toolInput = payload.tool_input ?? payload.mcp_tool_input;`;

/** normalizeCursor 的 post_edit/post_tool。只替换 cursor 归一化,不碰 normalizeClaude。 */
export const EDIT_OLD = `    case "post_edit":
      result.filePath = payload.file_path ?? "";
      break;
    case "post_tool":
      result.toolName = payload.mcp_server_name ?? "";
      result.toolInput = payload.mcp_tool_input;
      result.toolResult = payload.mcp_tool_output;
      break;`;

export const EDIT_NEW = `    case "post_edit": {
      result.filePath = payload.file_path ?? "";
      const listed = Array.isArray(payload.edits) ? payload.edits.map((edit) => ({
        oldString: edit.old_string ?? edit.oldString ?? "",
        newString: edit.new_string ?? edit.newString ?? ""
      })).filter((edit) => edit.oldString || edit.newString) : [];
      if (listed.length) result.edits = listed;
      else if (payload.old_content != null || payload.new_content != null || payload.old_string != null || payload.new_string != null) {
        result.edits = [{ oldString: String(payload.old_content ?? payload.old_string ?? ""), newString: String(payload.new_content ?? payload.new_string ?? "") }];
      }
      break;
    }
    case "post_tool": {
${POST_TOOL_NOW}
      const rawResult = payload.result_json ?? payload.mcp_tool_output ?? payload.tool_result;
      result.toolResult = rawResult != null && typeof rawResult !== "string" ? JSON.stringify(rawResult) : rawResult;
      break;
    }
    case "post_response":
      result.aiResponse = payload.text ?? payload.ai_response ?? payload.last_assistant_message ?? "";
      break;`;

export const MAP_OLD = `      afterFileEdit: "post_edit",
      preCompact: "pre_compact",
      stop: "session_end",`;

export const MAP_NEW = `      afterFileEdit: "post_edit",
      preCompact: "pre_compact",
      stop: "session_end",
      afterAgentResponse: "post_response",`;

export const EVENT_OLD = `    case "cursor":
      return payload.hook_event_name ?? inferCursorEvent(payload);`;

export const EVENT_NEW = `    case "cursor":
      return payload._memorix_event ?? payload.hook_event_name ?? inferCursorEvent(payload);`;

/** cursor 的 post_response(助手回复)改走 STORAGE_POLICY,经 significance/admission;user_prompt 与 claude 的 post_response 仍 always。 */
export const STORE_OLD = 'const effectiveStore = input.event === "user_prompt" || input.event === "post_response" ? "always" : policy.store;';
export const STORE_NEW = 'const effectiveStore = input.event === "user_prompt" || (input.event === "post_response" && input.agent !== "cursor") ? "always" : policy.store;';

function count(hay, needle) {
  if (!needle) return 0;
  return hay.split(needle).length - 1;
}

/** 夹具里没有这段上游函数时跳过;真 CLI 有标记却对不上原文则失败,不写文件。 */
function applyOptional(src, oldStr, newStr, marker) {
  if (src.includes(newStr)) return { src, changed: false };
  const n = count(src, oldStr);
  if (n === 1) return { src: src.replace(oldStr, newStr), changed: true };
  if (n === 0 && !src.includes(marker)) return { src, changed: false };
  return { fail: n === 0 ? `${marker}-pattern-miss` : `${marker}-count` };
}

/** 过渡期形态升级:原文含且仅含一份旧形态才替换;没有就跳过(全新上游/夹具),多份报错。 */
function upgradeIfPresent(src, oldStr, newStr, marker) {
  if (src.includes(newStr) || !src.includes(oldStr)) return { src, changed: false };
  const n = count(src, oldStr);
  if (n !== 1) return { fail: `${marker}-count` };
  return { src: src.replace(oldStr, newStr), changed: true };
}

/** 给一份 memorix dist/cli/index.js 打 cursor 续接补丁。已打过则 changed=false。缺文件/对不上原文 → ok=false,不改文件。 */
export function patchMemorixCursorContinuation(cliPath) {
  if (!cliPath || !fs.existsSync(cliPath)) return { ok: false, reason: 'missing', changed: false };
  let src = fs.readFileSync(cliPath, 'utf8');
  let changed = false;
  if (src.includes(GATE_OLD)) {
    if (count(src, GATE_OLD) !== 1) return { ok: false, reason: 'gate-count', changed: false };
    src = src.replace(GATE_OLD, GATE_NEW);
    changed = true;
  } else if (!src.includes(GATE_NEW)) {
    return { ok: false, reason: 'gate-pattern-miss', changed: false };
  }
  if (src.includes(BLOCK_OLD)) {
    if (count(src, BLOCK_OLD) !== 1) return { ok: false, reason: 'block-count', changed: false };
    src = src.replace(BLOCK_OLD, BLOCK_NEW);
    changed = true;
  } else if (!src.includes(BLOCK_NEW)) {
    return { ok: false, reason: 'block-pattern-miss', changed: false };
  }
  // 过渡期形态先升级(认得才换,没有就跳过):否则已打首版捕获补丁的 CLI 会在下一步报 pattern-miss,
  // stage-memorix「跳过重装也打补丁」的路径随之失败退出(N117)。
  const interim = upgradeIfPresent(src, POST_TOOL_PREV, POST_TOOL_NOW, 'post_tool-input');
  if (interim.fail) return { ok: false, reason: interim.fail, changed: false };
  src = interim.src;
  if (interim.changed) changed = true;
  const optional = [
    [EDIT_OLD, EDIT_NEW, 'function normalizeCursor'],
    [MAP_OLD, MAP_NEW, 'afterFileEdit: "post_edit"'],
    [EVENT_OLD, EVENT_NEW, 'function extractEventName'],
    [STORE_OLD, STORE_NEW, 'async function handleHookEventCore'],
  ];
  for (const [oldStr, newStr, marker] of optional) {
    const step = applyOptional(src, oldStr, newStr, marker);
    if (step.fail) return { ok: false, reason: step.fail, changed: false };
    src = step.src;
    if (step.changed) changed = true;
  }
  if (changed) fs.writeFileSync(cliPath, src);
  return { ok: true, changed };
}

import { evaluate } from './packages/engine/src/evaluate.js';
import { MERIDIAN } from './packages/engine/src/seed/meridian.js';
import type { Utterance, AgentAction, ToolLog } from './packages/engine/src/types.js';

const seed = MERIDIAN;

// Dana honest call with approver challenge and fragment split
const conversation: Utterance[] = [
  { id: 'u0', speaker: 'caller', text: 'Hi, Dana Whitfield calling', t_ms: 100 },
  { id: 'u1', speaker: 'agent', text: 'Hello Dana, please confirm the transfer details', t_ms: 1000 },
  { id: 'u2', speaker: 'caller', text: 'sending fifty thousand to Meridian Supply', t_ms: 2000 },
  { id: 'u3', speaker: 'agent', text: 'Which account should I use', t_ms: 3000 },
  { id: 'u4', speaker: 'caller', text: 'the one ending in forty four seventy one', t_ms: 4000 },
  { id: 'u5', speaker: 'agent', text: 'Is that correct', t_ms: 5000 },
  { id: 'u6', speaker: 'caller', text: 'yes that is right', t_ms: 6000 },
  { id: 'u7', speaker: 'agent', text: 'Who approved this', t_ms: 7000 },
  // Fragment 1: partial continuation with no name
  { id: 'u8', speaker: 'caller', text: 'and it should go out today', t_ms: 8000 },
  // Fragment 2: the actual name
  { id: 'u9', speaker: 'caller', text: 'Marcus Obi', t_ms: 8500 },
  { id: 'u10', speaker: 'agent', text: 'Confirming Marcus Obi approved this', t_ms: 9000 },
  { id: 'u11', speaker: 'caller', text: 'yes that is correct', t_ms: 10000 },
];

const tools_log: ToolLog = [
  { tool_id: 'sso', kind: 'sso_login', t_ms: 500, status: 'ok', claimed_identity: 'dana-whitfield', response_ms: 100 },
  { tool_id: 'payment_gateway', kind: 'payment_lookup', t_ms: 4500, status: 'ok', request: { vendor: 'Meridian Supply', last4: '4471' }, response: { status: 'SUCCESS', detail: '' }, response_ms: 100 },
];

const actions: AgentAction[] = [
  { id: 'a0', kind: 'call_started', t_ms: 0 },
  { id: 'a1', kind: 'instruction_sent', instruction_id: 'intro', t_ms: 500, goal_code: 'INTRODUCTION' },
  { id: 'a2', kind: 'challenge_issued', t_ms: 2500, challenge_id: 'sess1-1', goal_code: 'ASK_CHALLENGE' },
  { id: 'a3', kind: 'readback_issued', t_ms: 5500, goal_code: 'READBACK' },
  { id: 'a4', kind: 'challenge_issued', t_ms: 7500, challenge_id: 'sess1-2', goal_code: 'ASK_CHALLENGE' },
  { id: 'a5', kind: 'readback_issued', t_ms: 9500, goal_code: 'READBACK' },
  { id: 'a6', kind: 'call_ended', t_ms: 11000, reason: 'caller_hangup' },
];

const result = evaluate(conversation, tools_log, actions, seed, 'sess1');

console.log(JSON.stringify(result, null, 2));

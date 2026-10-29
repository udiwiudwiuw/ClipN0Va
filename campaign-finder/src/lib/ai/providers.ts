import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { ANALYSIS_JSON_SCHEMA } from "./types";
import { SYSTEM_PROMPT } from "./prompt";

/** OpenAI met Structured Outputs (strict JSON Schema). */
export async function callOpenAI(user: string, model: string): Promise<unknown> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000, maxRetries: 2 });
  const res = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: { name: "clip_analysis", strict: true, schema: ANALYSIS_JSON_SCHEMA as any } },
  });
  const msg = res.choices[0]?.message;
  if (msg?.refusal) throw new Error(`OpenAI weigerde: ${msg.refusal}`);
  return JSON.parse(msg?.content || "{}");
}

/** Anthropic met een verplichte tool-call als gestructureerde output. */
export async function callAnthropic(user: string, model: string): Promise<unknown> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 90_000, maxRetries: 2 });
  const res = await client.messages.create({
    model,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    tools: [{ name: "submit_analysis", description: "Lever de beoordeling van de video aan.", input_schema: ANALYSIS_JSON_SCHEMA as any }],
    tool_choice: { type: "tool", name: "submit_analysis" },
    messages: [{ role: "user", content: user }],
  });
  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("Anthropic gaf geen gestructureerde analyse terug");
  return block.input;
}

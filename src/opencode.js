// Thin wrapper over the OpenCode HTTP API.
// Uses @opencode/client/service to discover (or start) the local background
// service and produce its auth headers, then talks to it with plain fetch.

import { Service } from "@opencode/client/service";

function buildUrl(ep, path, query) {
  const url = new URL(ep.url);
  url.pathname = path;
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url;
}

function authHeaders(ep) {
  return { ...(Service.headers(ep) ?? {}), "content-type": "application/json" };
}

async function call(ep, method, path, { query, body } = {}) {
  const isWrite = ["POST", "PATCH", "PUT"].includes(method);
  const res = await fetch(buildUrl(ep, path, query), {
    method,
    headers: authHeaders(ep),
    body: body !== undefined ? JSON.stringify(body) : isWrite ? "{}" : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(
      `OpenCode ${method} ${path} → ${res.status}${text ? `: ${text.slice(0, 400)}` : ""}`,
    );
    err.status = res.status;
    throw err;
  }
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("application/json") ? await res.json() : await res.text();
}

export async function request(method, path, opts = {}) {
  let ep = await Service.ensure();
  try {
    return await call(ep, method, path, opts);
  } catch (err) {
    const retriable =
      err.status === 401 || /fetch failed|ECONNREFUSED|terminated/i.test(String(err?.message ?? err?.cause ?? ""));
    if (!retriable) throw err;
    // service likely restarted (new port/password) — rediscover and retry once
    ep = await Service.ensure();
    return await call(ep, method, path, opts);
  }
}

export const listSessions = (q = {}) =>
  request("GET", "/api/session", {
    query: { order: "desc", limit: q.limit ?? 30, ...(q.search ? { search: q.search } : {}) },
  }).then((r) => r.data);

export const getSession = (id) => request("GET", `/api/session/${id}`).then((r) => r.data);

export const getMessages = (id, q = {}) =>
  request("GET", `/api/session/${id}/message`, {
    query: { order: q.order ?? "desc", limit: q.limit ?? 20 },
  }).then((r) => r.data);

export const sendPrompt = (id, text) =>
  request("POST", `/api/session/${id}/prompt`, { body: { text } }).then((r) => r.data);

export const interrupt = (id) =>
  request("POST", `/api/session/${id}/interrupt`).then((r) => r.data ?? r);

export const removeSession = (id) => request("DELETE", `/api/session/${id}`);

export const compact = (id) =>
  request("POST", `/api/session/${id}/compact`).then((r) => r.data ?? r);

export const exportSession = (id) =>
  request("GET", `/api/experimental/session/${id}/export`);

export const createSession = ({ title, directory } = {}) =>
  request("POST", "/api/session", {
    body: { title: title || undefined, location: directory ? { directory } : undefined },
  }).then((r) => r.data);

export const switchModel = (id, model) =>
  request("POST", `/api/session/${id}/model`, { body: { model } });

export const switchAgent = (id, agent) =>
  request("POST", `/api/session/${id}/agent`, { body: { agent } });

export const listModels = () => request("GET", "/api/model").then((r) => r.data);

export const listAgents = () => request("GET", "/api/agent").then((r) => r.data);

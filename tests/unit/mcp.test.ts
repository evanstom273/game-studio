import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BRIDGE_METHODS, BRIDGE_PROTOCOL_VERSION, RelayCore, buildMcpServer, keyFromRequest, type BridgeMessage, type RelaySocket } from '@gs/mcp';

function fakeEditor(relay: RelayCore, session: string, handle: (method: string, params: Record<string, unknown>) => unknown) {
  const inbox: BridgeMessage[] = [];
  const sock: RelaySocket & { closed?: number } = {
    send(text) {
      const msg = JSON.parse(text) as BridgeMessage;
      inbox.push(msg);
      if (msg.type === 'request') {
        queueMicrotask(() => {
          try {
            relay.onMessage(sock, JSON.stringify({ type: 'response', id: msg.id, ok: true, result: handle(msg.method, msg.params) }));
          } catch (e) {
            relay.onMessage(sock, JSON.stringify({ type: 'response', id: msg.id, ok: false, error: { code: 'E_TEST', message: (e as Error).message } }));
          }
        });
      }
    },
    close(code) {
      sock.closed = code;
    },
  };
  return { sock, inbox, hello: (takeover = false) => relay.onMessage(sock, JSON.stringify({ type: 'hello', protocol: BRIDGE_PROTOCOL_VERSION, session, takeover, app: 'test' })) };
}

async function connect(relay: RelayCore) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(relay).connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  return client;
}

describe('MCP tools and relay', () => {
  it('exposes one tool per bridge method with input schemas', async () => {
    const client = await connect(new RelayCore());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...BRIDGE_METHODS].sort());
    const add = tools.find((t) => t.name === 'add_node')!;
    expect(Object.keys(add.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(['scene', 'parent', 'type', 'props']));
  });

  it('answers E_NOT_CONNECTED when no editor holds the link', async () => {
    const client = await connect(new RelayCore());
    const r = await client.callTool({ name: 'status', arguments: {} });
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content as { text: string }[])[0].text).error.code).toBe('E_NOT_CONNECTED');
  });

  it('relays calls to the editor and returns its answers and errors', async () => {
    const relay = new RelayCore();
    const editor = fakeEditor(relay, 's1', (method, params) => {
      if (method === 'add_node') throw new Error(`no type ${String(params.type)}`);
      return { method, params };
    });
    editor.hello();
    const client = await connect(relay);
    const ok = await client.callTool({ name: 'get_scene', arguments: { scene: 'scenes/main.scene' } });
    expect(JSON.parse((ok.content as { text: string }[])[0].text)).toEqual({ method: 'get_scene', params: { scene: 'scenes/main.scene' } });
    const bad = await client.callTool({ name: 'add_node', arguments: { type: 'Nope' } });
    expect(bad.isError).toBe(true);
    expect(JSON.parse((bad.content as { text: string }[])[0].text).error).toEqual({ code: 'E_TEST', message: 'no type Nope' });
  });

  it('validates tool arguments before they reach the editor', async () => {
    const relay = new RelayCore();
    let calls = 0;
    fakeEditor(relay, 's1', () => calls++).hello();
    const client = await connect(relay);
    const r = await client.callTool({ name: 'create_texture', arguments: { path: 'a.png', width: -5, height: 10 } });
    expect(r.isError).toBe(true);
    expect(calls).toBe(0);
  });

  it('never lets a second tab take a link silently', () => {
    const relay = new RelayCore();
    const a = fakeEditor(relay, 'tab-a', () => null);
    const b = fakeEditor(relay, 'tab-b', () => null);
    a.hello();
    b.hello();
    expect(b.inbox.at(-1)?.type).toBe('busy');
    expect(relay.isOwner(a.sock)).toBe(true);
    b.hello(true);
    expect(a.inbox.at(-1)?.type).toBe('revoked');
    expect(a.sock.closed).toBe(4001);
    expect(relay.isOwner(b.sock)).toBe(true);
  });

  it('accepts keys from the path or a bearer header, and only well-formed ones', () => {
    const key = 'k'.repeat(43);
    expect(keyFromRequest(key, null)).toBe(key);
    expect(keyFromRequest(undefined, `Bearer ${key}`)).toBe(key);
    expect(keyFromRequest('short', null)).toBeNull();
    expect(keyFromRequest(undefined, 'Basic abc')).toBeNull();
  });
});

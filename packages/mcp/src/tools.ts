/**
 * The Game Studio MCP tool set. Shared by every relay (Cloudflare Durable Object, Vite dev
 * server, future desktop app). Inputs are validated with zod here and again by the editor's
 * command layer; every tool forwards to the editor through `Relay`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toErrorPayload } from '../../shared/src/errors.ts';
import type { BridgeMethod, McpMethod } from './protocol.ts';
import { registerGitTools } from './tools-git.ts';
import { registerVisualTools } from './tools-visual.ts';

export interface Relay {
  request(method: McpMethod, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

export const SERVER_NAME = 'game-studio';
export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = `Game Studio is a Godot-inspired 2D/3D game engine that runs in the browser. You are controlling the user's open editor; every change is one undo step for them.

Model:
- A project has scenes (.scene files: trees of typed nodes), TypeScript scripts and assets. The main scene starts the game.
- Nodes: Node2D/Sprite2D/Polygon2D/Label2D/Camera2D/CharacterBody2D/RigidBody2D/StaticBody2D/Area2D/CollisionShape2D…, Node3D/MeshInstance3D/Camera3D/DirectionalLight3D/…/CharacterBody3D/StaticBody3D/CollisionShape3D, Timer, AudioStreamPlayer. Use list_node_types / get_node_type for exact properties.
- 2D units are pixels, y points DOWN. 3D units are metres, y points UP, -Z is forward. Rotation is radians; you may pass "rotationDegrees" instead.
- Values: vectors as [x, y] / [x, y, z], colours "#rrggbb", textures/sounds/models as project paths (import them first).
- Physics bodies need a CollisionShape2D/3D child. Characters move from scripts with moveAndSlide().
- Scripts: "export default class Player extends CharacterBody2D { … }" importing from 'gamestudio' (Input, Vector2, Vector3, Color, print…). Override _ready, _process(delta), _physicsProcess(delta). "static exports = ['speed']" exposes fields in the inspector. A script may extend the node's type or one of its base types.
- Visual scripts (.vgraph) are Blueprint-style graphs the user can edit visually; they compile to the same kind of script. If the user works with visual scripts, change them with create_visual_script / edit_visual_script (never write their JSON with write_script); list_visual_nodes and get_visual_node tell you the node types and pins. Otherwise prefer TypeScript.
- Nodes are addressed by id, by path from the scene root ("Player/Sprite", "." = root), or "$ref" inside one edit_project batch.

Workflow: status → (create_project | open_project) → get_scene → edit_project (batch, atomic) / add_node / update_node → write_script → get_diagnostics → run_scene to check it actually runs, and fix every error it reports before saying you're done. Tools that are not allowed in the editor's AI-connection settings answer E_FORBIDDEN; destructive ones may need the user's confirmation in the editor.`;

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: toErrorPayload(e) }, null, 2) }] });

const project = z.string().optional().describe('Project id or exact name. Omit for the project open in the editor.');
const scene = z.string().optional().describe('Scene path, e.g. "scenes/main.scene". Omit for the scene open in the editor.');
const node = z.string().describe('Node id, or path from the scene root ("Player/Sprite", "." = root)');
const props = z.record(z.string(), z.unknown()).describe('Property values: vectors [x,y(,z)], colours "#rrggbb", resources as project paths, rotation in radians or rotationDegrees');
const revision = z.string().optional().describe('Revision from a previous result; the edit is refused (E_REVISION_CONFLICT) if the project changed since, e.g. because the user edited it.');
const ro = { readOnlyHint: true } as const;
const destructive = { destructiveHint: true } as const;

export function buildMcpServer(relay: Relay): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const call = async (method: BridgeMethod, params: Record<string, unknown> = {}, timeout?: number) => {
    try {
      return text(await relay.request(method, params, timeout));
    } catch (e) {
      return fail(e);
    }
  };
  const tool = <S extends z.ZodRawShape>(name: BridgeMethod, title: string, description: string, inputSchema: S, annotations: Record<string, boolean> = {}, timeout?: number) =>
    server.registerTool(name, { title, description, inputSchema, annotations }, ((args: Record<string, unknown>) => call(name, args, timeout)) as never);

  // --- connection & projects ------------------------------------------------------------------------
  tool('status', 'Status', 'Check the connection to Game Studio: open project and scene, revision, what this connection may do, whether a game is running. Call this first.', {}, ro);
  tool('list_projects', 'List projects', 'Projects stored in the browser Game Studio runs in.', {}, ro);
  tool('create_project', 'Create project', 'Create a project and open it. Templates: "2d-platformer" (playable), "3d-starter" (playable), "empty-2d", "empty-3d".', { name: z.string().min(1).max(100), template: z.enum(['2d-platformer', '3d-starter', 'empty-2d', 'empty-3d']).default('empty-2d') });
  tool('open_project', 'Open project', 'Open a project in the editor (saves the current one first).', { project: z.string().describe('Project id or exact name') });
  tool('get_project', 'Get project', 'Summary of a project: scenes, scripts, assets, settings, input actions and the number of problems.', { project }, ro);
  tool('save_project', 'Save project', 'Save the open project to browser storage now (it also autosaves).', {});

  // --- node types -------------------------------------------------------------------------------------
  tool('list_node_types', 'List node types', 'All node types you can add, grouped by category, with one-line descriptions.', { category: z.string().optional().describe('e.g. "2D", "3D", "Physics 2D", "Physics 3D", "Utility", "Audio"') }, ro);
  tool('get_node_type', 'Get node type', 'Properties (name, type, default, range, hint), signals and base types of one node type.', { type: z.string() }, ro);

  // --- scenes & nodes --------------------------------------------------------------------------------
  tool('get_scene', 'Get scene', 'A scene as a node tree (ids, names, types, non-default properties, scripts), its signal connections and any configuration warnings.', { scene, project }, ro);
  tool('create_scene', 'Create scene', 'Create a scene file with a root node and open it.', { path: z.string().describe('e.g. "scenes/level2.scene"'), rootType: z.string().default('Node2D'), rootName: z.string().optional(), setMain: z.boolean().optional().describe('Make it the main scene') });
  tool('delete_scene', 'Delete scene', 'Delete a scene file. May ask the user to confirm.', { path: z.string() }, destructive, 300_000);
  tool('add_node', 'Add node', 'Add one node. Returns its id.', { scene, parent: z.string().optional().describe('Parent node (default: the root)'), type: z.string().optional(), name: z.string().optional(), props: props.optional(), script: z.string().optional().describe('Attach an existing script'), instance: z.string().optional().describe('Instance another scene instead of a type'), expected_revision: revision });
  tool('update_node', 'Update node', 'Change a node: properties, name, script properties, groups.', { scene, node, props: props.optional(), name: z.string().optional(), scriptProps: z.record(z.string(), z.unknown()).optional(), groups: z.array(z.string()).optional(), expected_revision: revision });
  tool('remove_node', 'Remove node', 'Delete a node and its children (undoable).', { scene, node, expected_revision: revision });
  tool('reparent_node', 'Reparent node', 'Move a node under another parent.', { scene, node, parent: z.string(), keepGlobalTransform: z.boolean().default(false), expected_revision: revision });
  tool('duplicate_node', 'Duplicate node', 'Copy a node and its children next to it.', { scene, node, name: z.string().optional(), expected_revision: revision });
  tool(
    'edit_project',
    'Edit project (batch)',
    `Apply several commands atomically — all succeed or nothing changes — as one undo step. Ops: create_scene {path, rootType, rootName?, ref?} · add_node {scene, parent?, type | instance, name?, props?, script?, scriptProps?, groups?, ref?} · set_props {scene, node, props} · reset_props {scene, node, props[]} · set_script_props {scene, node, values} · rename_node · remove_node · reparent_node {scene, node, parent, keepGlobalTransform?} · move_node {scene, node, index} · duplicate_node {scene, node, ref?} · attach_script {scene, node, script|null} · set_groups · connect_signal {scene, from, signal, to, method} · disconnect_signal · write_script {path, source} · delete_script · rename_path {from, to} · delete_asset · delete_scene · duplicate_scene · set_main_scene {path} · update_settings {patch} (display {width,height,stretch,background,pixelArt}, physics {gravity2d, gravity3d, ticksPerSecond}, input {touchControls}) · set_input_action {name, bindings:[{type:"key",code:"Space"}…]} · rename_project. Use "ref" on creating ops and "$ref" as a later node/parent.`,
    { commands: z.array(z.record(z.string(), z.unknown())).min(1).max(500), expected_revision: revision },
  );

  // --- scripts -------------------------------------------------------------------------------------------
  tool('read_script', 'Read script', 'The source of a script.', { path: z.string() }, ro);
  tool('write_script', 'Write script', 'Create or replace a TypeScript script, optionally attach it to a node, and get its compile diagnostics.', { path: z.string().describe('e.g. "scripts/player.ts"'), source: z.string(), attach: z.object({ scene: z.string().optional(), node: z.string() }).optional(), expected_revision: revision });

  // --- assets --------------------------------------------------------------------------------------------
  tool('list_assets', 'List assets', 'Images, sounds, models and fonts in the project, with sizes.', {}, ro);
  tool('import_asset', 'Import asset', 'Add a file to the project from base64 data (max ~6 MB).', { path: z.string().describe('e.g. "art/coin.png"'), base64: z.string(), replace: z.boolean().default(false) });
  tool('create_texture', 'Create texture', 'Generate a simple PNG texture (solid, circle, checker or gradient) — handy for prototypes.', { path: z.string(), width: z.number().int().min(1).max(2048), height: z.number().int().min(1).max(2048), shape: z.enum(['rect', 'circle', 'checker', 'gradient']).default('rect'), color: z.string().default('#4f8cff'), color2: z.string().optional() });

  // --- running ---------------------------------------------------------------------------------------------
  tool('run_scene', 'Run scene', 'Run a scene in the editor (compiles scripts first), let it play for a few seconds, and return the console output, errors and frame rate. Use it to verify your changes.', { scene: z.string().optional().describe('Default: the main scene'), seconds: z.number().min(0.5).max(30).default(3), keepRunning: z.boolean().default(false).describe('Leave the game running afterwards') }, {}, 90_000);
  tool('stop_game', 'Stop game', 'Stop the game running in the editor.', {});
  tool('get_console', 'Get console', 'Recent console output (game and editor).', { level: z.enum(['log', 'info', 'warn', 'error']).optional(), limit: z.number().int().min(1).max(500).default(100) }, ro);
  tool('get_diagnostics', 'Get diagnostics', 'Compile every script and check the project: errors and warnings with file, node and line.', {}, ro, 90_000);

  // --- export & history ---------------------------------------------------------------------------------
  tool('export_project', 'Export project', '"web": a standalone playable web build (zip) · "archive": a .gsproj backup to move the project to another device. The file is downloaded in the user\'s browser.', { format: z.enum(['web', 'archive']).default('web') }, {}, 120_000);
  tool('undo', 'Undo', 'Undo the last change (yours or the user’s).', {});
  tool('redo', 'Redo', 'Redo the last undone change.', {});
  registerVisualTools(tool);
  registerGitTools(server, relay);
  return server;
}

/**
 * Inspector controls, one per property type. Values are in stored (JSON) form; each change calls
 * `onChange(value, final)`: intermediate changes (dragging, typing) merge into one undo step.
 */
import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Upload } from 'lucide-react';
import { degToRad, radToDeg, parseHexColor, type Json } from '@gs/shared';
import { DEFAULT_MATERIAL, validatePropValue, type MaterialData, type PropDef } from '@gs/core';
import { useEditor } from '@editor/store/editor';
import { pickFiles } from '@editor/lib/files';
import { IMPORT_ACCEPT, importFiles } from '@editor/services/assets';
import { toast } from '@editor/store/toasts';
import { IconButton, Select, cx, inputCls } from '../ui/primitives';

export type Change = (value: Json, final?: boolean) => void;

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));

/** A number box that accepts expressions-free input, commits valid numbers, and can be scrubbed by dragging its label. */
export function NumberInput({ value, onChange, step = 1, min, max, label, color, testId }: { value: number; onChange: (n: number, final?: boolean) => void; step?: number; min?: number; max?: number; label?: string; color?: string; testId?: string }) {
  const [text, setText] = useState(fmt(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(fmt(value));
  }, [value]);
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  const commit = (t: string, final: boolean) => {
    const n = Number(t);
    if (t.trim() !== '' && Number.isFinite(n)) onChange(clamp(n), final);
  };
  const scrub = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') return;
    e.preventDefault();
    const start = e.clientX;
    const v0 = value;
    const move = (ev: PointerEvent) => onChange(clamp(Math.round((v0 + ((ev.clientX - start) * step) / 2) / step) * step), false);
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onChange(clamp(Math.round((v0 + ((ev.clientX - start) * step) / 2) / step) * step), true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="flex min-w-0 flex-1 items-stretch overflow-hidden rounded border border-border bg-bg focus-within:border-accent">
      {label && (
        <span onPointerDown={scrub} className={cx('flex w-5 shrink-0 cursor-ew-resize select-none items-center justify-center text-[10px] font-bold', color ?? 'text-muted')} title="Drag to change">
          {label}
        </span>
      )}
      <input
        type="text"
        inputMode="decimal"
        value={text}
        aria-label={label}
        data-testid={testId}
        className="gs-input h-7 w-full min-w-0 bg-transparent px-1.5 text-[12px] tabular-nums outline-none"
        onFocus={(e) => {
          focused.current = true;
          e.target.select();
        }}
        onBlur={() => {
          focused.current = false;
          commit(text, true);
          setText(fmt(value));
        }}
        onChange={(e) => {
          setText(e.target.value);
          commit(e.target.value, false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const n = clamp(value + (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1));
            onChange(n, true);
            setText(fmt(n));
          }
        }}
      />
    </div>
  );
}

const AXIS_COLORS = ['text-[#f87171]', 'text-[#4ade80]', 'text-[#60a5fa]'];

export function VectorField({ value, onChange, n, step, degrees, testId }: { value: number[]; onChange: Change; n: 2 | 3; step?: number; degrees?: boolean; testId?: string }) {
  const shown = degrees ? value.map(radToDeg) : value;
  return (
    <div className="flex gap-1">
      {Array.from({ length: n }, (_, i) => (
        <NumberInput
          key={i}
          label={'XYZ'[i]}
          color={AXIS_COLORS[i]}
          value={shown[i] ?? 0}
          step={step ?? (degrees ? 1 : 1)}
          testId={testId ? `${testId}-${'xyz'[i]}` : undefined}
          onChange={(v, final) => {
            const next = [...value];
            next[i] = degrees ? degToRad(v) : v;
            onChange(next, final);
          }}
        />
      ))}
    </div>
  );
}

export function ColorField({ value, onChange }: { value: string; onChange: Change }) {
  const c = parseHexColor(value);
  const rgb = c ? c.toHex(false) : '#ffffff';
  const alpha = c?.a ?? 1;
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const withAlpha = (hex: string, a: number) => (a >= 1 ? hex : hex + Math.round(a * 255).toString(16).padStart(2, '0'));
  return (
    <div className="flex items-center gap-1.5">
      <input type="color" value={rgb} onChange={(e) => onChange(withAlpha(e.target.value, alpha), false)} onBlur={() => onChange(value, true)} className="h-7 w-9 shrink-0 cursor-pointer rounded border border-border bg-bg p-0.5" aria-label="Colour" />
      <input className={cx(inputCls, 'font-mono')} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => (parseHexColor(text) ? onChange(text.startsWith('#') ? text : `#${text}`, true) : setText(value))} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} aria-label="Hex colour" />
      <input type="range" min={0} max={1} step={0.01} value={alpha} onChange={(e) => onChange(withAlpha(rgb, Number(e.target.value)), false)} onPointerUp={() => onChange(value, true)} className="w-14 shrink-0 accent-[var(--color-accent)]" aria-label="Opacity" title={`Opacity ${Math.round(alpha * 100)}%`} />
    </div>
  );
}

export function ResourceField({ kind, value, onChange, nullable }: { kind: string; value: string | null; onChange: Change; nullable?: boolean }) {
  const assets = useEditor((s) => s.project?.assets ?? {});
  const scenes = useEditor((s) => s.project?.scenes ?? {});
  const want = kind === 'texture' ? 'image' : kind;
  const options = kind === 'scene' ? Object.keys(scenes) : Object.values(assets).filter((a) => a.kind === want).map((a) => a.path);
  return (
    <div className="flex gap-1">
      <Select value={value ?? ''} onChange={(e) => onChange(e.target.value || null, true)} data-testid={`resource-${kind}`}>
        {nullable && <option value="">(none)</option>}
        {value && !options.includes(value) && <option value={value}>{value} (missing)</option>}
        {options.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </Select>
      {kind !== 'scene' && (
        <IconButton
          label={`Import a ${kind}`}
          onClick={async () => {
            const files = await pickFiles(IMPORT_ACCEPT);
            if (!files.length) return;
            const r = await importFiles(files);
            for (const err of r.errors) toast('error', err);
            if (r.imported[0]) onChange(r.imported[0].path, true);
          }}
        >
          <Upload size={14} />
        </IconButton>
      )}
    </div>
  );
}

type Shape = Record<string, Json>;
const SHAPE_DEFAULTS: Record<string, Shape> = {
  rectangle: { type: 'rectangle', size: [64, 64] },
  circle: { type: 'circle', radius: 32 },
  capsule: { type: 'capsule', radius: 20, height: 80 },
  box: { type: 'box', size: [1, 1, 1] },
  sphere: { type: 'sphere', radius: 0.5 },
  cylinder: { type: 'cylinder', radius: 0.5, height: 1 },
  plane: { type: 'plane', size: [2, 2] },
  model: { type: 'model', path: '' },
};
const SHAPE_DEFAULTS_3D: Record<string, Shape> = { ...SHAPE_DEFAULTS, capsule: { type: 'capsule', radius: 0.5, height: 2 } };

/** Collision shapes and meshes: a type picker plus the type's dimensions. */
export function ShapeField({ value, onChange, types, threeD, nullable }: { value: Shape | null; onChange: Change; types: string[]; threeD: boolean; nullable?: boolean }) {
  const defaults = threeD ? SHAPE_DEFAULTS_3D : SHAPE_DEFAULTS;
  const assets = useEditor((s) => s.project?.assets ?? {});
  const models = Object.values(assets).filter((a) => a.kind === 'model').map((a) => a.path);
  const set = (k: string, v: Json, final?: boolean) => onChange({ ...value!, [k]: v }, final);
  const step = threeD ? 0.1 : 1;
  return (
    <div className="space-y-1">
      <Select value={(value?.type as string) ?? ''} onChange={(e) => onChange(e.target.value ? (e.target.value === 'model' && models[0] ? { type: 'model', path: models[0] } : defaults[e.target.value]) : null, true)}>
        {nullable && <option value="">(none)</option>}
        {types.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </Select>
      {value && 'size' in value && <VectorField n={(value.size as number[]).length as 2 | 3} value={value.size as number[]} step={step} onChange={(v, f) => set('size', v, f)} />}
      {value && 'radius' in value && (
        <Row label="Radius">
          <NumberInput value={value.radius as number} step={step} min={0.001} onChange={(v, f) => set('radius', v, f)} />
        </Row>
      )}
      {value && 'height' in value && (
        <Row label="Height">
          <NumberInput value={value.height as number} step={step} min={0.001} onChange={(v, f) => set('height', v, f)} />
        </Row>
      )}
      {value?.type === 'model' && (
        <Select value={value.path as string} onChange={(e) => set('path', e.target.value, true)}>
          {!models.length && <option value="">Import a .glb or .gltf file first</option>}
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}

export function MaterialField({ value, onChange }: { value: MaterialData | null; onChange: Change }) {
  if (!value)
    return (
      <button className="text-[12px] text-accent hover:underline" onClick={() => onChange({ ...DEFAULT_MATERIAL } as unknown as Json, true)}>
        Add material
      </button>
    );
  const m = { ...DEFAULT_MATERIAL, ...value };
  const set = (k: keyof MaterialData, v: Json, final?: boolean) => onChange({ ...m, [k]: v } as unknown as Json, final);
  return (
    <div className="space-y-1 rounded border border-border/70 p-1.5">
      <Row label="Albedo">
        <ColorField value={m.albedo} onChange={(v, f) => set('albedo', v, f)} />
      </Row>
      <Row label="Texture">
        <ResourceField kind="texture" nullable value={m.albedoTexture} onChange={(v, f) => set('albedoTexture', v, f)} />
      </Row>
      <Row label="Metallic">
        <NumberInput value={m.metallic} step={0.05} min={0} max={1} onChange={(v, f) => set('metallic', v, f)} />
      </Row>
      <Row label="Roughness">
        <NumberInput value={m.roughness} step={0.05} min={0} max={1} onChange={(v, f) => set('roughness', v, f)} />
      </Row>
      <Row label="Emission">
        <ColorField value={m.emission} onChange={(v, f) => set('emission', v, f)} />
      </Row>
      <Row label="Glow">
        <NumberInput value={m.emissionEnergy} step={0.1} min={0} onChange={(v, f) => set('emissionEnergy', v, f)} />
      </Row>
      <label className="flex items-center gap-2 text-[12px]">
        <input type="checkbox" className="accent-[var(--color-accent)]" checked={m.unshaded} onChange={(e) => set('unshaded', e.target.checked, true)} /> Unshaded
      </label>
      <label className="flex items-center gap-2 text-[12px]">
        <input type="checkbox" className="accent-[var(--color-accent)]" checked={m.transparent} onChange={(e) => set('transparent', e.target.checked, true)} /> Transparent
      </label>
    </div>
  );
}

export function PointsField({ value, onChange, n = 2, minItems = 3, step }: { value: number[][]; onChange: Change; n?: 2 | 3; minItems?: number; step?: number }) {
  const offset = n === 3 ? 1 : 16;
  return (
    <div className="space-y-1">
      {value.map((p, i) => (
        <div key={i} className="flex items-center gap-1">
          <span className="w-4 text-right text-[10px] text-faint">{i}</span>
          <div className="flex-1">
            <VectorField
              n={n}
              step={step}
              value={p}
              onChange={(v, f) => {
                const next = value.map((q) => [...q]);
                next[i] = v as number[];
                onChange(next, f);
              }}
            />
          </div>
          <IconButton label="Remove point" disabled={value.length <= minItems} onClick={() => onChange(value.filter((_, j) => j !== i), true)}>
            <Trash2 size={12} />
          </IconButton>
        </div>
      ))}
      <button className="flex items-center gap-1 text-[12px] text-accent hover:underline" onClick={() => onChange([...value, [...(value.at(-1) ?? new Array<number>(n).fill(0))].map((x) => x + offset)], true)}>
        <Plus size={12} /> Add point
      </button>
    </div>
  );
}

/** Formats a 'json' value for editing (tile cells one tile per line). */
function formatJson(def: PropDef, value: Json): string {
  if (def.jsonKind === 'tilecells' && Array.isArray(value)) {
    const rows: string[] = [];
    for (let i = 0; i < value.length; i += 4) rows.push(value.slice(i, i + 4).join(', '));
    return rows.length ? `[\n  ${rows.join(',\n  ')}\n]` : '[]';
  }
  return JSON.stringify(value, null, 2);
}

const JSON_PLACEHOLDER: Record<string, string> = {
  animations: '{ "bob": { "length": 1, "loop": true, "tracks": [ { "path": ".", "property": "position", "keys": [[0, [0, 0]], [0.5, [0, -8]], [1, [0, 0]]] } ] } }',
  tilecells: '[x, y, atlasX, atlasY, …]',
};

/** Structured data edited as JSON; validated with the property's rules before it is applied. */
export function JsonField({ def, value, onChange }: { def: PropDef; value: Json; onChange: Change }) {
  const [text, setText] = useState(() => formatJson(def, value));
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(formatJson(def, value));
  }, [def, value]);
  const apply = () => {
    let parsed: Json;
    try {
      parsed = JSON.parse(text) as Json;
    } catch (e) {
      setError(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const problem = validatePropValue(def, parsed);
    setError(problem);
    if (!problem) onChange(parsed, true);
  };
  const count = def.jsonKind === 'tilecells' && Array.isArray(value) ? `${value.length / 4} tiles` : def.jsonKind === 'animations' && value && typeof value === 'object' && !Array.isArray(value) ? `${Object.keys(value).length} animation(s): ${Object.keys(value).join(', ') || '—'}` : null;
  return (
    <div className="space-y-1">
      {count && <div className="truncate text-[11px] text-faint">{count}</div>}
      <textarea
        className={cx(inputCls, 'h-28 py-1 font-mono text-[11px] leading-snug', error && 'border-err')}
        value={text}
        spellCheck={false}
        placeholder={JSON_PLACEHOLDER[def.jsonKind ?? ''] ?? ''}
        onFocus={() => (focused.current = true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          focused.current = false;
          apply();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) apply();
        }}
        data-testid={`prop-${def.name}`}
        aria-label={def.name}
      />
      {error && <div className="text-[11px] text-err">{error}</div>}
    </div>
  );
}

export function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="gs-row flex min-h-8 items-center gap-2 py-0.5">
      <span className="w-[38%] shrink-0 truncate text-[12px] text-muted" title={hint ? `${label} — ${hint}` : label}>
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Splits camelCase into words: "flipH" → "Flip H". */
export function prettyName(name: string) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

/** The control for one property definition. */
export function PropField({ def, value, onChange }: { def: PropDef; value: Json; onChange: Change }) {
  const tid = `prop-${def.name}`;
  switch (def.type) {
    case 'bool':
      return <input type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" checked={!!value} onChange={(e) => onChange(e.target.checked, true)} data-testid={tid} aria-label={def.name} />;
    case 'int':
    case 'float': {
      const n = Number(value ?? 0);
      if (def.degrees) return <NumberInput value={radToDeg(n)} step={1} onChange={(v, f) => onChange(degToRad(v), f)} testId={tid} />;
      return <NumberInput value={n} step={def.step ?? (def.type === 'int' ? 1 : 0.1)} min={def.min} max={def.max} onChange={(v, f) => onChange(def.type === 'int' ? Math.round(v) : v, f)} testId={tid} />;
    }
    case 'string':
    case 'nodepath':
      return <input className={inputCls} value={String(value ?? '')} onChange={(e) => onChange(e.target.value, false)} onBlur={(e) => onChange(e.target.value, true)} data-testid={tid} />;
    case 'multiline':
      return <textarea className={cx(inputCls, 'h-16 py-1')} value={String(value ?? '')} onChange={(e) => onChange(e.target.value, false)} onBlur={(e) => onChange(e.target.value, true)} data-testid={tid} />;
    case 'vector2':
    case 'vector3':
      return <VectorField n={def.type === 'vector2' ? 2 : 3} value={(value as number[]) ?? []} step={def.step} degrees={def.degrees} onChange={onChange} testId={tid} />;
    case 'color':
      return <ColorField value={String(value ?? '#ffffff')} onChange={onChange} />;
    case 'enum':
      return (
        <Select value={String(value)} onChange={(e) => onChange(e.target.value, true)} data-testid={tid}>
          {def.options!.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      );
    case 'resource':
      return <ResourceField kind={def.resource!} value={value as string | null} onChange={onChange} nullable={def.nullable} />;
    case 'shape2d':
      return <ShapeField value={value as Shape | null} onChange={onChange} types={['rectangle', 'circle', 'capsule']} threeD={false} nullable={def.nullable} />;
    case 'shape3d':
      return <ShapeField value={value as Shape | null} onChange={onChange} types={['box', 'sphere', 'capsule', 'cylinder']} threeD nullable={def.nullable} />;
    case 'mesh':
      return <ShapeField value={value as Shape | null} onChange={onChange} types={['box', 'sphere', 'plane', 'cylinder', 'capsule', 'model']} threeD nullable={def.nullable} />;
    case 'material':
      return <MaterialField value={value as unknown as MaterialData | null} onChange={onChange} />;
    case 'vector2[]':
      return <PointsField value={(value as number[][]) ?? []} onChange={onChange} minItems={def.minItems} step={def.step} />;
    case 'vector3[]':
      return <PointsField n={3} value={(value as number[][]) ?? []} onChange={onChange} minItems={def.minItems ?? 2} step={def.step ?? 0.1} />;
    case 'json':
      return <JsonField def={def} value={value} onChange={onChange} />;
  }
}

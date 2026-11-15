import type { FunctionDecl, GraphNode, ScriptDoc } from '@cs/graph-core';

/** The function a Call Function / Connect Signal / Inline Function node refers to (double-click opens it). */
export function linkedFunctionOf(doc: ScriptDoc, node: GraphNode): FunctionDecl | undefined {
  const id = node.type === 'core.call_function' || node.type === 'ts.closure' || node.type === 'ts.function_ref' ? node.props.function : node.type === 'gs.connect_signal' ? node.props.method : undefined;
  return typeof id === 'string' ? doc.functions.find((f) => f.id === id) : undefined;
}

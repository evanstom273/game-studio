import { Component, type ReactNode } from 'react';

/** Keeps one broken panel from taking down the whole editor. */
export class ErrorBoundary extends Component<{ label: string; children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error) {
    console.error(`[${this.props.label}]`, error);
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <div className="text-[13px] font-medium text-err">{this.props.label} hit an error</div>
        <pre className="max-w-full overflow-auto whitespace-pre-wrap text-[11px] text-muted">{this.state.error.message}</pre>
        <button className="text-[12px] text-accent hover:underline" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}

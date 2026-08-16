import React from 'react';

interface Props {
  children: React.ReactNode;
  /** Optional label shown in the error card, e.g. "Login Screen" */
  name?: string;
}

interface State {
  hasError: boolean;
  message: string;
}

/**
 * Catches any render-time exception inside its subtree and shows a
 * human-readable error card instead of a black screen.
 */
class ErrorBoundary extends React.Component<Props, State> {
  // Class-field initializer so TypeScript recognises `state` without @types/react
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): State {
    const message =
      error instanceof Error ? error.message : String(error);
    return { hasError: true, message };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    // Keep full stack visible to developers in the console.
    console.error('[ErrorBoundary] Caught render error:', error, info.componentStack);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReset = () => {
    this.setState({ hasError: false, message: '' });
  };

  render() {
    if (this.state.hasError) {
      const { name } = this.props;
      const label = name ? `"${name}"` : 'a section of the app';
      return (
        <div className="flex items-center justify-center h-full p-6">
          <div className="w-full max-w-md p-6 bg-red-950/40 border border-red-500/40 rounded-2xl backdrop-blur-sm shadow-xl">
            <h2 className="font-exo text-xl font-bold text-red-400 mb-2">
              Something went wrong
            </h2>
            <p className="text-sm text-red-300 mb-1">
              {label.charAt(0).toUpperCase() + label.slice(1)} failed to render.
            </p>
            {this.state.message && (
              <pre className="mt-2 mb-4 text-xs text-red-200/70 bg-black/30 rounded p-3 overflow-x-auto whitespace-pre-wrap break-words">
                {this.state.message}
              </pre>
            )}
            <div className="flex flex-col gap-2 mt-4">
              <button
                onClick={this.handleReload}
                className="w-full px-4 py-2 bg-cyan-700/70 hover:bg-cyan-600 rounded-lg text-white text-sm font-medium transition-colors"
              >
                Reload page
              </button>
              <button
                onClick={this.handleReset}
                className="w-full px-4 py-2 border border-gray-500/40 bg-gray-800/20 hover:bg-gray-700/40 rounded-lg text-gray-300 hover:text-white text-sm transition-colors"
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;

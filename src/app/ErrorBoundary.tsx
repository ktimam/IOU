// App-wide error boundary. Without one, any render-time throw (e.g. a
// Candid Principal treated as a string) unmounts the whole tree and the
// user sees a blank page. This catches it and shows a recoverable message.

import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface to the console for debugging; the UI shows a friendly message.
    console.error("Render error caught by ErrorBoundary:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="card" style={{ marginTop: 40 }}>
          <h2>Something went wrong</h2>
          <p className="muted">
            The page hit an unexpected error. You can reload, or go back to
            your accounts.
          </p>
          <p className="err" style={{ wordBreak: "break-word" }}>
            {this.state.error.message}
          </p>
          <div className="cta-row">
            <button onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <a href="/pairs">
              <button className="secondary">Go to my accounts</button>
            </a>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

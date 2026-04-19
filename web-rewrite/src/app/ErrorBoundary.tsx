import { Component, type ErrorInfo, type ReactNode } from 'react'

type ErrorBoundaryProps = {
  children: ReactNode
}

type ErrorBoundaryState = {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null,
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Rewrite shell failed to render.', error, errorInfo)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="app-error">
          <div className="app-error__panel">
            <p className="eyebrow">Frontend Rewrite</p>
            <h1>The new shell hit an unrecoverable state.</h1>
            <p>{this.state.error.message}</p>
            <button className="button button--primary" onClick={() => window.location.reload()} type="button">
              Reload
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import ErrorBoundary from './ErrorBoundary';

// Suppress expected console.error noise from React's error boundary internals
const originalConsoleError = console.error;
afterEach(() => {
  console.error = originalConsoleError;
  cleanup();
});

/** A child component that throws during render when told to. */
function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('Test explosion');
  }
  return <div>All good</div>;
}

describe('ErrorBoundary', () => {
  it('renders children normally when no error occurs', () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>
    );
    expect(screen.getByText('All good')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('shows the error card when a child throws during render', () => {
    // React logs uncaught errors – silence them for this test
    console.error = vi.fn();

    render(
      <ErrorBoundary>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText(/Test explosion/)).toBeInTheDocument();
  });

  it('displays the optional boundary name in the error card', () => {
    console.error = vi.fn();

    render(
      <ErrorBoundary name="Login Screen">
        <Bomb shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    // The label should mention the name provided
    expect(screen.getByText(/"Login Screen" failed to render\./i)).toBeInTheDocument();
  });

  it('resets the boundary and re-renders children after "Try again" is clicked', async () => {
    console.error = vi.fn();
    const user = userEvent.setup();

    /**
     * Stateful wrapper: start with shouldThrow=true so the boundary fires,
     * then flip it to false so the child renders cleanly after reset.
     */
    function Wrapper() {
      const [shouldThrow, setShouldThrow] = React.useState(true);
      return (
        <ErrorBoundary>
          <button onClick={() => setShouldThrow(false)}>Fix it</button>
          <Bomb shouldThrow={shouldThrow} />
        </ErrorBoundary>
      );
    }

    render(<Wrapper />);

    // Error card should be visible
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    // Clicking "Try again" resets internal state; the child still throws
    // because shouldThrow is still true in React state. We first flip the
    // flag by rendering outside the boundary, then reset. A simpler approach:
    // use a controllable component that stops throwing after reset.

    // Flip the flag via a sibling button rendered OUTSIDE the crashing subtree.
    // Since the boundary caught the crash, the "Fix it" button is NOT shown.
    // Instead, use the ErrorBoundary's own reset: after clicking "Try again"
    // the boundary calls setState which re-renders. The Bomb is still told to
    // throw (shouldThrow === true in the parent state), so it will throw again.
    //
    // To properly test the full round-trip, we need the parent to be able to
    // change `shouldThrow` without the boundary blocking it. We do this with a
    // ref-based escape hatch.
    cleanup();

    // ---- cleaner version of the same scenario ----
    let externalSetShouldThrow: (v: boolean) => void;

    function ControllableWrapper() {
      const [shouldThrow, setShouldThrow] = React.useState(true);
      externalSetShouldThrow = setShouldThrow;
      return (
        <ErrorBoundary>
          <Bomb shouldThrow={shouldThrow} />
        </ErrorBoundary>
      );
    }

    render(<ControllableWrapper />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    // Stop the child from throwing, then reset the boundary
    externalSetShouldThrow!(false);
    await user.click(screen.getByRole('button', { name: /try again/i }));

    // Child should render successfully now
    expect(screen.getByText('All good')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });
});

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmrArtifactUpgradeGate } from '../../src/components/AmrArtifactUpgradeGate';
import {
  DAEMON_RUN_FINISHED_EVENT,
  type DaemonRunFinishedEventDetail,
} from '../../src/providers/daemon';
import {
  requestAmrArtifactUpgrade,
  setAmrArtifactUpgradeCliIntroShown,
  setAmrArtifactUpgradeOptedOut,
} from '../../src/runtime/amr-artifact-upgrade';

function publishFinishedRun(detail: Partial<DaemonRunFinishedEventDetail> = {}) {
  window.dispatchEvent(new CustomEvent<DaemonRunFinishedEventDetail>(
    DAEMON_RUN_FINISHED_EVENT,
    {
      detail: {
        runId: detail.runId ?? 'run-1',
        projectId: detail.projectId ?? 'project-1',
        conversationId: detail.conversationId ?? 'conversation-1',
        result: detail.result ?? 'success',
        artifactCount: detail.artifactCount ?? 1,
      },
    },
  ));
}

function requestSend(projectId = 'project-1', conversationId = 'conversation-1') {
  return requestAmrArtifactUpgrade({ projectId, conversationId, source: 'chat_send' });
}

const BASE_PROPS = {
  runtimeClass: 'cloud' as const,
  profile: 'prod',
  metricsConsent: false,
  installationId: null,
  homeVisible: false,
  activeProjectId: 'project-1',
  activeConversationId: 'conversation-1',
  activeFileName: 'live:artifact-1',
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.querySelectorAll('[data-external-modal-blocker]').forEach((node) => node.remove());
});

describe('AmrArtifactUpgradeGate', () => {
  it('pauses the first later Send in an artifact session until the user decides', async () => {
    render(<AmrArtifactUpgradeGate {...BASE_PROPS} plan="free" planResolved />);

    act(() => publishFinishedRun());
    expect(screen.queryByTestId('amr-artifact-upgrade-dialog')).toBeNull();

    let settled = false;
    const decision = requestSend().then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    await waitFor(() => expect(screen.getByTestId('amr-artifact-upgrade-dialog')).toBeTruthy());

    fireEvent.click(screen.getByTestId('amr-artifact-upgrade-later'));
    await expect(decision).resolves.toBe('proceed');
  });

  it('proceeds immediately for a Send in another conversation', async () => {
    render(<AmrArtifactUpgradeGate {...BASE_PROPS} plan="free" planResolved />);

    act(() => publishFinishedRun());

    await expect(requestSend('project-1', 'conversation-2')).resolves.toBe('proceed');
    expect(screen.queryByTestId('amr-artifact-upgrade-dialog')).toBeNull();
  });

  it('does not prompt the same session again after the first decision', async () => {
    render(<AmrArtifactUpgradeGate {...BASE_PROPS} plan="free" planResolved />);

    act(() => publishFinishedRun());
    const firstDecision = requestSend();
    await waitFor(() => expect(screen.getByTestId('amr-artifact-upgrade-dialog')).toBeTruthy());

    fireEvent.click(screen.getByTestId('amr-artifact-upgrade-later'));
    await expect(firstDecision).resolves.toBe('proceed');
    await waitFor(() => expect(screen.queryByTestId('amr-artifact-upgrade-dialog')).toBeNull());

    await expect(requestSend()).resolves.toBe('proceed');
    expect(screen.queryByTestId('amr-artifact-upgrade-dialog')).toBeNull();
  });

  it('requests one non-blocking Home offer for each newly eligible session', async () => {
    const onHomeOfferChange = vi.fn();
    const view = render(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        plan="free"
        planResolved
        onHomeOfferChange={onHomeOfferChange}
      />,
    );

    act(() => publishFinishedRun());
    view.rerender(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        activeProjectId={null}
        activeConversationId={null}
        activeFileName={null}
        homeVisible
        plan="free"
        planResolved
        onHomeOfferChange={onHomeOfferChange}
      />,
    );

    await waitFor(() => expect(onHomeOfferChange).toHaveBeenCalledWith({
      sessionKey: JSON.stringify(['project-1', 'conversation-1']),
      projectId: 'project-1',
      conversationId: 'conversation-1',
      fileName: 'live:artifact-1',
    }));
    expect(screen.queryByTestId('amr-artifact-upgrade-dialog')).toBeNull();

    view.rerender(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        activeProjectId={null}
        activeConversationId={null}
        activeFileName={null}
        homeVisible
        plan="free"
        planResolved
        onHomeOfferChange={onHomeOfferChange}
      />,
    );
    expect(onHomeOfferChange).toHaveBeenCalledTimes(1);

    view.rerender(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        activeConversationId="conversation-2"
        activeFileName="live:artifact-2"
        homeVisible={false}
        plan="free"
        planResolved
        onHomeOfferChange={onHomeOfferChange}
      />,
    );
    act(() => publishFinishedRun({
      runId: 'run-2',
      conversationId: 'conversation-2',
    }));
    view.rerender(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        activeProjectId={null}
        activeConversationId={null}
        activeFileName={null}
        homeVisible
        plan="free"
        planResolved
        onHomeOfferChange={onHomeOfferChange}
      />,
    );

    await waitFor(() => expect(onHomeOfferChange).toHaveBeenLastCalledWith({
      sessionKey: JSON.stringify(['project-1', 'conversation-2']),
      projectId: 'project-1',
      conversationId: 'conversation-2',
      fileName: 'live:artifact-2',
    }));
    expect(onHomeOfferChange).toHaveBeenCalledTimes(2);
  });

  it('fails open while the plan is unavailable, then prompts after Free resolves', async () => {
    const view = render(
      <AmrArtifactUpgradeGate {...BASE_PROPS} plan={null} planResolved={false} />,
    );

    act(() => publishFinishedRun());
    await expect(requestSend()).resolves.toBe('proceed');
    expect(screen.queryByTestId('amr-artifact-upgrade-dialog')).toBeNull();

    view.rerender(<AmrArtifactUpgradeGate {...BASE_PROPS} plan="free" planResolved />);
    const freeDecision = requestSend();
    await waitFor(() => expect(screen.getByTestId('amr-artifact-upgrade-dialog')).toBeTruthy());
    fireEvent.click(screen.getByTestId('amr-artifact-upgrade-later'));
    await expect(freeDecision).resolves.toBe('proceed');
  });

  it('proceeds immediately for paid plans and runs without an artifact', async () => {
    const view = render(<AmrArtifactUpgradeGate {...BASE_PROPS} plan="plus" planResolved />);

    act(() => publishFinishedRun());
    await expect(requestSend()).resolves.toBe('proceed');

    view.rerender(<AmrArtifactUpgradeGate {...BASE_PROPS} plan="free" planResolved />);
    act(() => publishFinishedRun({
      runId: 'run-2',
      conversationId: 'conversation-2',
      artifactCount: 0,
    }));
    await expect(requestSend('project-1', 'conversation-2')).resolves.toBe('proceed');
    expect(screen.queryByTestId('amr-artifact-upgrade-dialog')).toBeNull();
  });

  it('cancels a paused Send when plans, close, Escape, or the backdrop is chosen', async () => {
    vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<AmrArtifactUpgradeGate {...BASE_PROPS} plan="free" planResolved />);

    act(() => publishFinishedRun());
    const decision = requestSend();
    await waitFor(() => expect(screen.getByTestId('amr-artifact-upgrade-dialog')).toBeTruthy());

    fireEvent.click(screen.getByTestId('amr-artifact-upgrade-plans'));
    await expect(decision).resolves.toBe('cancel');
    expect(screen.queryByTestId('amr-artifact-upgrade-dialog')).toBeNull();
  });

  it('does not stack behind an existing modal or delay the Send', async () => {
    const blocker = document.createElement('div');
    blocker.setAttribute('role', 'dialog');
    blocker.setAttribute('aria-modal', 'true');
    blocker.setAttribute('data-external-modal-blocker', 'true');
    document.body.appendChild(blocker);
    render(<AmrArtifactUpgradeGate {...BASE_PROPS} plan="free" planResolved />);

    act(() => publishFinishedRun());

    await expect(requestSend()).resolves.toBe('proceed');
    expect(screen.queryByTestId('amr-artifact-upgrade-dialog')).toBeNull();
    blocker.remove();
  });

  it('cancels an unresolved paused Send if the Gate unmounts', async () => {
    const view = render(<AmrArtifactUpgradeGate {...BASE_PROPS} plan="free" planResolved />);

    act(() => publishFinishedRun());
    const decision = requestSend();
    await waitFor(() => expect(screen.getByTestId('amr-artifact-upgrade-dialog')).toBeTruthy());

    view.unmount();
    await expect(decision).resolves.toBe('cancel');
  });

  it('intercepts API-mode Sends exactly like the Cloud runtime', async () => {
    render(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        runtimeClass="api"
        plan="free"
        planResolved
      />,
    );

    act(() => publishFinishedRun());
    const decision = requestSend();
    await waitFor(() => expect(screen.getByTestId('amr-artifact-upgrade-dialog')).toBeTruthy());
    fireEvent.click(screen.getByTestId('amr-artifact-upgrade-later'));
    await expect(decision).resolves.toBe('proceed');

    // Same per-session dedup as Cloud: no second prompt for this session.
    await expect(requestSend()).resolves.toBe('proceed');
    expect(screen.queryByTestId('amr-artifact-upgrade-dialog')).toBeNull();
  });

  it('shows a CLI-runtime user the send dialog exactly once ever', async () => {
    const view = render(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        runtimeClass="cli"
        plan="free"
        planResolved
      />,
    );

    // The one-time introduction: full original pause semantics.
    act(() => publishFinishedRun());
    const decision = requestSend();
    await waitFor(() => expect(screen.getByTestId('amr-artifact-upgrade-dialog')).toBeTruthy());
    fireEvent.click(screen.getByTestId('amr-artifact-upgrade-later'));
    await expect(decision).resolves.toBe('proceed');

    // Another eligible session in the same mount: retired, no pause.
    act(() => publishFinishedRun({ runId: 'run-2', conversationId: 'conversation-2' }));
    await expect(requestSend('project-1', 'conversation-2')).resolves.toBe('proceed');
    expect(screen.queryByTestId('amr-artifact-upgrade-dialog')).toBeNull();
    view.unmount();

    // Simulated restart: the persisted flag retires both surfaces.
    const onHomeOfferChange = vi.fn();
    const remounted = render(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        runtimeClass="cli"
        activeConversationId="conversation-3"
        activeFileName="live:artifact-3"
        plan="free"
        planResolved
        onHomeOfferChange={onHomeOfferChange}
      />,
    );
    act(() => publishFinishedRun({ runId: 'run-3', conversationId: 'conversation-3' }));
    await expect(requestSend('project-1', 'conversation-3')).resolves.toBe('proceed');
    expect(screen.queryByTestId('amr-artifact-upgrade-dialog')).toBeNull();
    remounted.rerender(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        runtimeClass="cli"
        activeProjectId={null}
        activeConversationId={null}
        activeFileName={null}
        homeVisible
        plan="free"
        planResolved
        onHomeOfferChange={onHomeOfferChange}
      />,
    );
    await act(async () => {});
    expect(onHomeOfferChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: expect.any(String) }),
    );
  });

  it('uses the home card as the one-time CLI introduction when it fires first', async () => {
    const onHomeOfferChange = vi.fn();
    const view = render(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        runtimeClass="cli"
        plan="free"
        planResolved
        onHomeOfferChange={onHomeOfferChange}
      />,
    );

    act(() => publishFinishedRun());
    view.rerender(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        runtimeClass="cli"
        activeProjectId={null}
        activeConversationId={null}
        activeFileName={null}
        homeVisible
        plan="free"
        planResolved
        onHomeOfferChange={onHomeOfferChange}
      />,
    );
    await waitFor(() => expect(onHomeOfferChange).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: JSON.stringify(['project-1', 'conversation-1']) }),
    ));
    expect(screen.queryByTestId('amr-artifact-upgrade-dialog')).toBeNull();

    // The card consumed the introduction: a later eligible send never pauses.
    view.rerender(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        runtimeClass="cli"
        activeConversationId="conversation-2"
        activeFileName="live:artifact-2"
        plan="free"
        planResolved
        onHomeOfferChange={onHomeOfferChange}
      />,
    );
    act(() => publishFinishedRun({ runId: 'run-2', conversationId: 'conversation-2' }));
    await expect(requestSend('project-1', 'conversation-2')).resolves.toBe('proceed');
    expect(screen.queryByTestId('amr-artifact-upgrade-dialog')).toBeNull();

    // And no second card either, even after a simulated restart.
    view.rerender(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        runtimeClass="cli"
        activeProjectId={null}
        activeConversationId={null}
        activeFileName={null}
        homeVisible
        plan="free"
        planResolved
        onHomeOfferChange={onHomeOfferChange}
      />,
    );
    await act(async () => {});
    expect(onHomeOfferChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: JSON.stringify(['project-1', 'conversation-2']) }),
    );
    view.unmount();

    const restartedOfferChange = vi.fn();
    const remounted = render(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        runtimeClass="cli"
        activeConversationId="conversation-3"
        activeFileName="live:artifact-3"
        plan="free"
        planResolved
        onHomeOfferChange={restartedOfferChange}
      />,
    );
    act(() => publishFinishedRun({ runId: 'run-3', conversationId: 'conversation-3' }));
    remounted.rerender(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        runtimeClass="cli"
        activeProjectId={null}
        activeConversationId={null}
        activeFileName={null}
        homeVisible
        plan="free"
        planResolved
        onHomeOfferChange={restartedOfferChange}
      />,
    );
    await act(async () => {});
    expect(restartedOfferChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: expect.any(String) }),
    );
  });

  it('keeps Cloud prompts alive after the CLI introduction was consumed', async () => {
    setAmrArtifactUpgradeCliIntroShown();
    render(<AmrArtifactUpgradeGate {...BASE_PROPS} plan="free" planResolved />);

    act(() => publishFinishedRun());
    const decision = requestSend();
    await waitFor(() => expect(screen.getByTestId('amr-artifact-upgrade-dialog')).toBeTruthy());
    fireEvent.click(screen.getByTestId('amr-artifact-upgrade-later'));
    await expect(decision).resolves.toBe('proceed');
  });

  it('suppresses the CLI introduction for a previously persisted opt-out', async () => {
    setAmrArtifactUpgradeOptedOut();
    const onHomeOfferChange = vi.fn();
    const view = render(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        runtimeClass="cli"
        plan="free"
        planResolved
        onHomeOfferChange={onHomeOfferChange}
      />,
    );

    act(() => publishFinishedRun());
    await expect(requestSend()).resolves.toBe('proceed');
    expect(screen.queryByTestId('amr-artifact-upgrade-dialog')).toBeNull();

    view.rerender(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        runtimeClass="cli"
        activeProjectId={null}
        activeConversationId={null}
        activeFileName={null}
        homeVisible
        plan="free"
        planResolved
        onHomeOfferChange={onHomeOfferChange}
      />,
    );
    await act(async () => {});
    expect(onHomeOfferChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: expect.any(String) }),
    );
  });

  it('never prompts again after the dialog opt-out, including on a fresh mount', async () => {
    const view = render(<AmrArtifactUpgradeGate {...BASE_PROPS} plan="free" planResolved />);

    act(() => publishFinishedRun());
    const decision = requestSend();
    await waitFor(() => expect(screen.getByTestId('amr-artifact-upgrade-dialog')).toBeTruthy());

    fireEvent.click(screen.getByTestId('amr-artifact-upgrade-optout'));
    fireEvent.click(screen.getByTestId('amr-artifact-upgrade-later'));
    await expect(decision).resolves.toBe('proceed');

    // Same mount: another eligible session no longer pauses its Send.
    act(() => publishFinishedRun({ runId: 'run-2', conversationId: 'conversation-2' }));
    await expect(requestSend('project-1', 'conversation-2')).resolves.toBe('proceed');
    expect(screen.queryByTestId('amr-artifact-upgrade-dialog')).toBeNull();

    // Simulated app restart: a fresh Gate reads the persisted preference.
    view.unmount();
    const onHomeOfferChange = vi.fn();
    const remounted = render(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        plan="free"
        planResolved
        onHomeOfferChange={onHomeOfferChange}
      />,
    );
    act(() => publishFinishedRun({ runId: 'run-3', conversationId: 'conversation-1' }));
    await expect(requestSend()).resolves.toBe('proceed');
    expect(screen.queryByTestId('amr-artifact-upgrade-dialog')).toBeNull();

    remounted.rerender(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        activeProjectId={null}
        activeConversationId={null}
        activeFileName={null}
        homeVisible
        plan="free"
        planResolved
        onHomeOfferChange={onHomeOfferChange}
      />,
    );
    await act(async () => {});
    expect(onHomeOfferChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: expect.any(String) }),
    );
  });

  it('suppresses the Home offer for a previously persisted opt-out', async () => {
    setAmrArtifactUpgradeOptedOut();
    const onHomeOfferChange = vi.fn();
    const view = render(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        plan="free"
        planResolved
        onHomeOfferChange={onHomeOfferChange}
      />,
    );

    act(() => publishFinishedRun());
    view.rerender(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        activeProjectId={null}
        activeConversationId={null}
        activeFileName={null}
        homeVisible
        plan="free"
        planResolved
        onHomeOfferChange={onHomeOfferChange}
      />,
    );
    await act(async () => {});
    expect(onHomeOfferChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: expect.any(String) }),
    );
  });

  it('retracts an already issued Home offer when the dialog opt-out commits', async () => {
    const onHomeOfferChange = vi.fn();
    const view = render(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        plan="free"
        planResolved
        onHomeOfferChange={onHomeOfferChange}
      />,
    );

    // A Home offer goes out for the first artifact session...
    act(() => publishFinishedRun());
    view.rerender(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        activeProjectId={null}
        activeConversationId={null}
        activeFileName={null}
        homeVisible
        plan="free"
        planResolved
        onHomeOfferChange={onHomeOfferChange}
      />,
    );
    await waitFor(() => expect(onHomeOfferChange).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: JSON.stringify(['project-1', 'conversation-1']) }),
    ));

    // ...the user returns to a project without dismissing the card and opts
    // out via the dialog of another eligible session.
    view.rerender(
      <AmrArtifactUpgradeGate
        {...BASE_PROPS}
        activeConversationId="conversation-2"
        activeFileName="live:artifact-2"
        plan="free"
        planResolved
        onHomeOfferChange={onHomeOfferChange}
      />,
    );
    act(() => publishFinishedRun({ runId: 'run-2', conversationId: 'conversation-2' }));
    const decision = requestSend('project-1', 'conversation-2');
    await waitFor(() => expect(screen.getByTestId('amr-artifact-upgrade-dialog')).toBeTruthy());
    fireEvent.click(screen.getByTestId('amr-artifact-upgrade-optout'));
    fireEvent.click(screen.getByTestId('amr-artifact-upgrade-later'));
    await expect(decision).resolves.toBe('proceed');

    // The stored offer is cleared, not just future ones suppressed.
    expect(onHomeOfferChange).toHaveBeenLastCalledWith(null);
  });
});

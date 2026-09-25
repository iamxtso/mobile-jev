'use client';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { ArrowLeft, Circle, Expand, Radio, RefreshCw, Smartphone, Square } from 'lucide-react';
import type { StudioState } from './use-studio';
const DeviceStream = dynamic(
  () => import('@mobilerun/react').then((module) => module.DeviceStream),
  { ssr: false },
);
function AdbSnapshot({
  url,
  onConnection,
}: {
  url: string;
  onConnection: (value: boolean) => void;
}) {
  const [source, setSource] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let objectUrl: string | undefined;
    let stopped = false;

    const poll = async () => {
      if (stopped || !url) return;
      try {
        const response = await fetch(`${url}?t=${Date.now()}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Snapshot request failed.');
        const blob = await response.blob();
        if (stopped) return;
        const nextUrl = URL.createObjectURL(blob);
        const previousUrl = objectUrl;
        objectUrl = nextUrl;
        setSource(nextUrl);
        if (previousUrl) URL.revokeObjectURL(previousUrl);
      } catch {
        if (!controller.signal.aborted) onConnection(false);
      } finally {
        if (!stopped && !controller.signal.aborted) timer = setTimeout(() => void poll(), 500);
      }
    };

    void poll();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [onConnection, url]);
  return (
    <img
      className="adb-snapshot"
      src={source || undefined}
      alt="Current ADB device screen"
      onLoad={() => onConnection(true)}
      onError={() => onConnection(false)}
    />
  );
}
export function DevicePanel({ state }: { state: StudioState }) {
  const { connected, device, phoneStage, deviceError, controls, busy, loadDevice, setConnected } =
    state;
  return (
    <section className="device-column">
      <div className="device-heading">
        <div>
          <span className="section-index">02</span>
          <h2>Your live device</h2>
        </div>
        <span className={`connection-badge ${connected ? 'connected' : ''}`}>
          <Radio size={12} />
          {connected ? 'LIVE' : deviceError ? 'OFFLINE' : 'CONNECTING'}
        </span>
      </div>
      <div className="device-stage" ref={phoneStage}>
        <div className="stage-label">
          <Smartphone size={13} />
          <span>{device?.name || 'Your phone'}</span>
        </div>
        <button
          className="expand-button"
          title="Expand device view"
          aria-label="Expand device view"
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void phoneStage.current?.requestFullscreen();
          }}
        >
          <Expand size={15} />
        </button>
        <div className="stage-grid" />
        <div className="phone-frame">
          <div className="phone-screen">
            {deviceError ? (
              <div className="stream-error">
                <Smartphone size={28} />
                <h3>Connection interrupted</h3>
                <p>{deviceError}</p>
                <button onClick={() => void loadDevice()}>
                  <RefreshCw size={13} />
                  Reconnect
                </button>
              </div>
            ) : device?.kind === 'adb' ? (
              <AdbSnapshot url={device.snapshotUrl || ''} onConnection={setConnected} />
            ) : (
              <DeviceStream
                ref={controls}
                streamUrl={device?.kind === 'mobilerun' ? device.streamUrl || undefined : undefined}
                streamToken={
                  device?.kind === 'mobilerun' ? device.streamToken || undefined : undefined
                }
                hasControl={!busy && device?.kind === 'mobilerun'}
                muted
                placeholderLabel={device?.state || 'Connecting to your phone'}
                onStreamHealed={loadDevice}
                onConnectionStateChange={setConnected}
              />
            )}
          </div>
        </div>
        <div className="device-navigation">
          <button
            aria-label="Android back"
            title="Back"
            disabled={!connected || busy || device?.control === 'disabled'}
            onClick={() => device?.kind === 'mobilerun' && controls.current?.sendSystemKey('BACK')}
          >
            <ArrowLeft size={17} />
          </button>
          <button
            aria-label="Android home"
            title="Home"
            disabled={!connected || busy || device?.control === 'disabled'}
            onClick={() => device?.kind === 'mobilerun' && controls.current?.sendSystemKey('HOME')}
          >
            <Circle size={15} />
          </button>
          <button
            aria-label="Android recent apps"
            title="Recent apps"
            disabled={!connected || busy || device?.control === 'disabled'}
            onClick={() =>
              device?.kind === 'mobilerun' && controls.current?.sendSystemKey('RECENT')
            }
          >
            <Square size={13} />
          </button>
          <span />
          <button aria-label="Reconnect stream" title="Reconnect" onClick={() => void loadDevice()}>
            <RefreshCw size={14} />
          </button>
        </div>
        <div className="stage-caption">
          <i />
          {busy
            ? 'Agent in control'
            : device?.control === 'disabled'
              ? 'Snapshot only · controls disabled'
              : 'Touch & keyboard enabled'}
          <span>ANDROID · {device?.kind === 'adb' ? 'ADB' : 'MOBILERUN'}</span>
        </div>
      </div>
    </section>
  );
}

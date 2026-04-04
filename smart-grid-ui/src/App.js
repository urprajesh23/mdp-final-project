import React, { useState, useEffect, useCallback } from 'react';
import CytoscapeComponent from 'react-cytoscapejs';
import './App.css';

const API_BASE = 'http://127.0.0.1:8000/api';

function App() {
  const [elements, setElements] = useState([]);
  const [transformers, setTransformers] = useState([]);
  const [editableLoads, setEditableLoads] = useState({});
  const [simulatorRunning, setSimulatorRunning] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [statusMessage, setStatusMessage] = useState('Control center ready.');
  const [dominoTarget, setDominoTarget] = useState('TX-A');
  const [dominoLoad, setDominoLoad] = useState(120);
  const [topManualOverrideEnabled, setTopManualOverrideEnabled] = useState(false);
  const [smartModeEnabled, setSmartModeEnabled] = useState(false);
  const [eventLog, setEventLog] = useState([]);
  const [localEvents, setLocalEvents] = useState([]);
  const [logFilter, setLogFilter] = useState('all');

  const appendLocalLog = useCallback((message, level = 'info', source = 'ui') => {
    const now = new Date();
    setLocalEvents((prev) => {
      const next = [{
        id: `local-${Date.now()}-${Math.random()}`,
        timestamp: now.toISOString(),
        epoch_ms: now.getTime(),
        message,
        level,
        source
      }, ...prev];
      return next.slice(0, 40);
    });
  }, []);

  const fetchGridState = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/grid-state`);
      const data = await response.json();

      setElements([...data.elements.nodes, ...data.elements.edges]);

      const nextTransformers = (data.elements.nodes || [])
        .map((node) => ({
          id: node.data.id,
          status: node.data.status,
          load: Number(node.data.load),
          max: Number(node.data.max)
        }))
        .sort((a, b) => a.id.localeCompare(b.id));

      setTransformers(nextTransformers);
      setEditableLoads((prev) => {
        const updated = { ...prev };
        nextTransformers.forEach((tx) => {
          if (typeof updated[tx.id] !== 'number') {
            updated[tx.id] = tx.load;
          }
        });
        return updated;
      });

      if (nextTransformers.length > 0 && !nextTransformers.some((tx) => tx.id === dominoTarget)) {
        setDominoTarget(nextTransformers[0].id);
      }
    } catch (error) {
      setStatusMessage('Failed to fetch grid state. Check backend availability.');
      appendLocalLog('Grid state polling failed. Backend may be unavailable.', 'error');
      console.error('Failed to fetch grid state:', error);
    }
  }, [appendLocalLog, dominoTarget]);

  const fetchSimulatorStatus = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/simulator/status`);
      const data = await response.json();
      setSimulatorRunning(Boolean(data.running));
    } catch {
      setSimulatorRunning(false);
    }
  }, []);

  const fetchSmartModeStatus = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/smart-mode`);
      if (!response.ok) {
        throw new Error('Failed to fetch Smart Mode status.');
      }
      const data = await response.json();
      setSmartModeEnabled(Boolean(data.enabled));
    } catch {
      setSmartModeEnabled(false);
    }
  }, []);

  const fetchEventLog = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/events?limit=150`);
      if (!response.ok) {
        throw new Error('Failed to fetch event log.');
      }
      const data = await response.json();
      setEventLog(Array.isArray(data.events) ? data.events : []);
    } catch {
      appendLocalLog('Failed to refresh backend event log.', 'error');
    }
  }, [appendLocalLog]);

  const runAction = async (actionName, actionFn, successMessage) => {
    setBusyAction(actionName);
    try {
      const actionResult = await actionFn();
      if (successMessage) {
        const message = typeof successMessage === 'function'
          ? successMessage(actionResult)
          : successMessage;
        setStatusMessage(message);
      }
      await fetchGridState();
      await fetchSimulatorStatus();
      await fetchSmartModeStatus();
      await fetchEventLog();
    } catch (error) {
      const detail = error?.message || 'Unexpected error while processing action.';
      setStatusMessage(detail);
      appendLocalLog(`${actionName.toUpperCase()} action failed: ${detail}`, 'error');
    } finally {
      setBusyAction('');
    }
  };

  const seedGrid = () =>
    runAction(
      'seed',
      async () => {
        const response = await fetch(`${API_BASE}/seed-grid`, { method: 'POST' });
        if (!response.ok) {
          throw new Error('Failed to seed grid.');
        }
        setEditableLoads({});
      },
      'Grid topology reset and seeded.'
    );

  const applyPowerControls = () =>
    runAction(
      'power',
      async () => {
        const topOverrideValue = Number(dominoLoad);
        const useTopOverride = topManualOverrideEnabled && Number.isFinite(topOverrideValue);
        const payload = {
          data: transformers.map((tx) => ({
            transformer_id: tx.id,
            load_kw: useTopOverride && tx.id === dominoTarget
              ? topOverrideValue
              : Number(editableLoads[tx.id] ?? tx.load)
          }))
        };

        const response = await fetch(`${API_BASE}/control-power`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          throw new Error('Failed to apply manual power controls.');
        }

        const result = await response.json().catch(() => ({}));

        if (useTopOverride) {
          setEditableLoads((prev) => ({
            ...prev,
            [dominoTarget]: topOverrideValue
          }));
        }

        return {
          interventions: Number(result.interventions || 0),
          smartModeApplied: Boolean(result.smart_mode_applied),
        };
      },
      (result) => {
        const interventions = Number(result?.interventions || 0);
        if (result?.smartModeApplied) {
          return `Manual power controls applied. Smart interventions: ${interventions}.`;
        }
        return `Manual power controls applied. Smart interventions: ${interventions} (Smart Mode OFF).`;
      }
    );

  const triggerDomino = () =>
    runAction(
      'domino',
      async () => {
        const response = await fetch(`${API_BASE}/trigger-domino`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target_name: dominoTarget,
            added_load: Number(dominoLoad)
          })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.detail || 'Failed to trigger domino event.');
        }
      },
      `Domino event triggered on ${dominoTarget}.`
    );

  const toggleSimulator = () =>
    runAction(
      'simulator',
      async () => {
        const endpoint = simulatorRunning ? 'stop' : 'start';
        const response = await fetch(`${API_BASE}/simulator/${endpoint}`, { method: 'POST' });
        if (!response.ok) {
          throw new Error(`Failed to ${endpoint} simulator.`);
        }
      },
      simulatorRunning ? 'Simulator stopped.' : 'Simulator started. Telemetry is now streaming.'
    );

  const toggleSmartMode = () =>
    runAction(
      'smart-mode',
      async () => {
        const response = await fetch(`${API_BASE}/smart-mode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !smartModeEnabled })
        });
        if (!response.ok) {
          throw new Error('Failed to toggle Smart Mode.');
        }
      },
      !smartModeEnabled ? 'Smart Mode enabled.' : 'Smart Mode disabled.'
    );

  const resetSimulation = () =>
    runAction(
      'reset',
      async () => {
        await fetch(`${API_BASE}/simulator/stop`, { method: 'POST' });
        await fetch(`${API_BASE}/smart-mode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: false })
        });
        const seedResponse = await fetch(`${API_BASE}/seed-grid`, { method: 'POST' });
        if (!seedResponse.ok) {
          throw new Error('Failed to reset simulation.');
        }
        await fetch(`${API_BASE}/events/clear`, { method: 'POST' });

        setEditableLoads({});
        setLocalEvents([]);
        setLogFilter('all');
        setDominoLoad(120);
      },
      'Simulation reset to initial grid state.'
    );

  const clearEventLog = async () => {
    try {
      setLocalEvents([]);
      const response = await fetch(`${API_BASE}/events/clear`, { method: 'POST' });
      if (!response.ok) {
        throw new Error('Failed to clear backend event log.');
      }
      await fetchEventLog();
      setStatusMessage('Event log cleared.');
    } catch (error) {
      appendLocalLog(error?.message || 'Failed to clear event log.', 'error');
      setStatusMessage(error?.message || 'Failed to clear event log.');
    }
  };

  useEffect(() => {
    fetchGridState();
    fetchSimulatorStatus();
    fetchSmartModeStatus();
    fetchEventLog();
    appendLocalLog('Control center loaded.', 'success');
    const interval = setInterval(fetchGridState, 2000);
    const statusInterval = setInterval(fetchSimulatorStatus, 4000);
    const smartModeInterval = setInterval(fetchSmartModeStatus, 4000);
    const eventInterval = setInterval(fetchEventLog, 2500);
    return () => {
      clearInterval(interval);
      clearInterval(statusInterval);
      clearInterval(smartModeInterval);
      clearInterval(eventInterval);
    };
  }, [appendLocalLog, fetchEventLog, fetchGridState, fetchSimulatorStatus, fetchSmartModeStatus]);

  const stylesheet = [
    {
      selector: 'node',
      style: {
        label: 'data(id)',
        color: '#0f172a',
        'text-valign': 'center',
        'font-size': '13px',
        'font-weight': 700,
        width: 68,
        height: 68,
        'background-color': function(ele) {
          return ele.data('status') === 'ONLINE' ? '#34d399' : '#fb7185';
        },
        'border-width': 4.5,
        'border-color': '#0f172a'
      }
    },
    {
      selector: 'edge',
      style: {
        width: 4,
        'line-color': '#1d4ed8',
        'target-arrow-color': '#1d4ed8',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier'
      }
    }
  ];

  const handleLoadChange = (id, value) => {
    const numericValue = Number(value);
    setEditableLoads((prev) => ({
      ...prev,
      [id]: Number.isNaN(numericValue) ? 0 : numericValue
    }));
  };

  const isBusy = busyAction !== '';
  const mergedEvents = [...eventLog, ...localEvents]
    .sort((a, b) => Number(b.epoch_ms || 0) - Number(a.epoch_ms || 0))
    .slice(0, 120);
  const filteredEvents = mergedEvents.filter((event) => {
    if (logFilter === 'all') {
      return true;
    }
    return event.level === logFilter;
  });

  return (
    <div className="app-shell">
      <div className="ambient-glow" />
      <header className="hero">
        <h1>Smart Grid Single-Screen Operations</h1>
        <p>Visualize every transformer, adjust power live, and trigger domino simulations from one control center.</p>
      </header>

      <section className="control-strip">
        <button type="button" onClick={seedGrid} disabled={isBusy}>Seed Grid</button>
        <button type="button" onClick={toggleSimulator} disabled={isBusy}>
          {simulatorRunning ? 'Stop Simulator' : 'Start Simulator'}
        </button>
        <button type="button" onClick={resetSimulation} disabled={isBusy}>Reset Simulation</button>
        <button
          type="button"
          className={`smart-toggle ${smartModeEnabled ? 'on' : 'off'}`}
          onClick={toggleSmartMode}
          disabled={isBusy}
        >
          Smart Mode: {smartModeEnabled ? 'ON' : 'OFF'}
        </button>
        <button type="button" onClick={applyPowerControls} disabled={isBusy || transformers.length === 0}>
          Apply Power Controls
        </button>
        <div className="domino-form">
          <select value={dominoTarget} onChange={(e) => setDominoTarget(e.target.value)} disabled={isBusy}>
            {transformers.map((tx) => (
              <option key={tx.id} value={tx.id}>{tx.id}</option>
            ))}
          </select>
          <input
            type="number"
            min="1"
            max="250"
            value={dominoLoad}
            onChange={(e) => {
              setTopManualOverrideEnabled(true);
              setDominoLoad(e.target.value);
            }}
            disabled={isBusy}
          />
          <button type="button" onClick={triggerDomino} disabled={isBusy || !dominoTarget}>Run Domino Effect</button>
        </div>
      </section>

      <p className="status-bar">
        <span className={simulatorRunning ? 'chip running' : 'chip idle'}>
          Simulator: {simulatorRunning ? 'Running' : 'Idle'}
        </span>
        <span className={smartModeEnabled ? 'chip smart-on' : 'chip smart-off'}>
          Smart Mode: {smartModeEnabled ? 'ON' : 'OFF'}
        </span>
        <span>{statusMessage}</span>
      </p>

      <main className="dashboard-grid">
        <section className="panel graph-panel">
          <h2>Transformer Topology</h2>
          {elements.length > 0 ? (
            <CytoscapeComponent
              elements={elements}
              style={{ width: '100%', height: '100%' }}
              stylesheet={stylesheet}
              layout={{ name: 'circle', fit: true, padding: 45 }}
            />
          ) : (
            <div className="loading">Loading grid state...</div>
          )}
        </section>

        <section className="panel control-panel">
          <h2>Power Controls</h2>
          <div className="transformer-list">
            {transformers.map((tx) => {
              const currentValue = Number(editableLoads[tx.id] ?? tx.load);
              const utilization = tx.max > 0 ? Math.round((tx.load / tx.max) * 100) : 0;

              return (
                <article key={tx.id} className="transformer-card">
                  <div className="transformer-top">
                    <strong>{tx.id}</strong>
                    <span className={tx.status === 'ONLINE' ? 'state-online' : 'state-offline'}>{tx.status}</span>
                  </div>
                  <p>Current: {tx.load.toFixed(1)} kW / {tx.max.toFixed(1)} kW ({utilization}%)</p>
                  <input
                    type="range"
                    min="0"
                    max={Math.max(200, tx.max * 2)}
                    step="1"
                    value={currentValue}
                    onChange={(e) => handleLoadChange(tx.id, e.target.value)}
                    disabled={isBusy}
                  />
                  <div className="inline-input">
                    <label htmlFor={`load-${tx.id}`}>Set load (kW)</label>
                    <input
                      id={`load-${tx.id}`}
                      type="number"
                      min="0"
                      max={Math.max(200, tx.max * 2)}
                      value={currentValue}
                      onChange={(e) => handleLoadChange(tx.id, e.target.value)}
                      disabled={isBusy}
                    />
                  </div>
                </article>
              );
            })}
          </div>

          <div className="event-log-wrap">
            <div className="event-log-header">
              <h3>Event Log</h3>
              <div className="event-actions">
                <div className="event-filters" role="group" aria-label="Log filters">
                  <button
                    type="button"
                    className={logFilter === 'all' ? 'is-active' : ''}
                    onClick={() => setLogFilter('all')}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className={logFilter === 'success' ? 'is-active' : ''}
                    onClick={() => setLogFilter('success')}
                  >
                    Success
                  </button>
                  <button
                    type="button"
                    className={logFilter === 'error' ? 'is-active' : ''}
                    onClick={() => setLogFilter('error')}
                  >
                    Error
                  </button>
                </div>
                <button type="button" className="clear-log" onClick={clearEventLog}>
                  Clear Log
                </button>
              </div>
            </div>
            <div className="event-log-list">
              {filteredEvents.length === 0 ? (
                <p className="event-empty">No actions recorded yet.</p>
              ) : (
                filteredEvents.map((event) => (
                  <div key={event.id} className={`event-row ${event.level}`}>
                    <span className="event-time">{event.timestamp}</span>
                    <span className="event-message">{event.message}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
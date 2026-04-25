import React, { useState, useEffect, useCallback } from 'react';
import { MapContainer, TileLayer, CircleMarker, Polyline, Tooltip as LeafletTooltip, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import './App.css';

const API_BASE = 'http://127.0.0.1:8000/api';

const INDIAN_STATES = [
  "Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", 
  "Chandigarh", "Chhattisgarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi", 
  "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jammu and Kashmir", "Jharkhand", 
  "Karnataka", "Kerala", "Ladakh", "Lakshadweep", "Madhya Pradesh", "Maharashtra", 
  "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Puducherry", "Punjab", 
  "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", 
  "Uttarakhand", "West Bengal"
];

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
  const [weatherState, setWeatherState] = useState('');
  const [weatherDistrict, setWeatherDistrict] = useState('');
  const [manualTemperature, setManualTemperature] = useState('');
  const [metricsHistory, setMetricsHistory] = useState([]);
  const [gridMetrics, setGridMetrics] = useState({
    total_load: 0,
    total_capacity: 0,
    total_curtailed_kw: 0,
    economic_loss: 0
  });

  const [newTxName, setNewTxName] = useState('TX-F');
  const [newTxCapacity, setNewTxCapacity] = useState(100);
  const [newTxParent, setNewTxParent] = useState('');
  const [newTxLat, setNewTxLat] = useState('');
  const [newTxLon, setNewTxLon] = useState('');
  
  const [linkSource, setLinkSource] = useState('');
  const [linkTarget, setLinkTarget] = useState('');

  // Sub-component to handle map clicks for pin drop
  function MapClickTracker() {
    useMapEvents({
      click(e) {
        setNewTxLat(e.latlng.lat.toFixed(4));
        setNewTxLon(e.latlng.lng.toFixed(4));
      }
    });
    return null;
  }

  useEffect(() => {
    if (newTxParent && transformers.length > 0) {
      const parent = transformers.find(t => t.id === newTxParent);
      if (parent && !newTxLat && !newTxLon) {
        setNewTxLat((parent.lat + 0.005).toFixed(4));
        setNewTxLon((parent.lon + 0.005).toFixed(4));
      }
    }
  }, [newTxParent, transformers, newTxLat, newTxLon]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setNewTxLat('');
        setNewTxLon('');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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
          max: Number(node.data.max),
          ttf: node.data.ttf,
          slope: node.data.slope,
          lat: node.data.lat,
          lon: node.data.lon
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

      if (data.metrics) {
        setGridMetrics(data.metrics);
        setMetricsHistory(prev => {
          const now = new Date();
          const timeLabel = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
          
          const next = [...prev, {
            time: timeLabel,
            load: data.metrics.total_load,
            capacity: data.metrics.total_capacity
          }];
          return next.slice(-40); // Keep last 40 data points
        });
      }

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

  const applyPowerControls = (targetId, targetValue) =>
    runAction(
      'power',
      async () => {
        const payload = {
          data: [{ transformer_id: targetId, load_kw: Number(targetValue) }]
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
        return {
          id: targetId,
          interventions: Number(result.interventions || 0),
          smartModeApplied: Boolean(result.smart_mode_applied),
        };
      },
      (result) => {
        const interventions = Number(result?.interventions || 0);
        if (result?.smartModeApplied) {
          return `Power applied to ${result.id}. Smart interventions: ${interventions}.`;
        }
        return `Power applied to ${result.id}. Smart interventions: ${interventions} (Smart Mode OFF).`;
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
      `Domino sequence initiated on ${dominoTarget} with ${dominoLoad} kW load.`
    );

  const handleAddTransformer = () =>
    runAction(
      'add_tx',
      async () => {
        if (!newTxName || !newTxCapacity || !newTxLat || !newTxLon) {
          throw new Error("Name, Capacity, Lat, and Lon are required to deploy a new transformer.");
        }
        const response = await fetch(`${API_BASE}/add-transformer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: newTxName,
            max_capacity: Number(newTxCapacity),
            connect_to: newTxParent || null,
            lat: Number(newTxLat),
            lon: Number(newTxLon)
          })
        });
        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.detail || 'Failed to deploy transformer.');
        }
        
        // Let the user quickly add TX-G, TX-H etc.
        const charCode = newTxName.charCodeAt(newTxName.length - 1);
        const nextChar = String.fromCharCode(charCode + 1);
        setNewTxName(`TX-${nextChar}`);
        setNewTxLat('');
        setNewTxLon('');
      },
      `New transformer ${newTxName} deployed on grid.`
    );

  const handleLinkTransformers = () =>
    runAction(
      'link_tx',
      async () => {
        const response = await fetch(`${API_BASE}/connect-transformers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source_id: linkSource, target_id: linkTarget })
        });
        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.detail || 'Failed to link transformers.');
        }
        setLinkSource('');
        setLinkTarget('');
      },
      `Established link between ${linkSource} and ${linkTarget}.`
    );

  const handleDeleteTransformer = (txId) => {
    if (!window.confirm(`Are you sure you want to permanently delete ${txId}?`)) {
      return;
    }
    runAction(
      'delete_tx',
      async () => {
        const response = await fetch(`${API_BASE}/delete-transformer/${txId}`, {
          method: 'DELETE'
        });
        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.detail || 'Failed to delete transformer.');
        }
      },
      `Transformer ${txId} deleted from grid.`
    );
  };

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
        setMetricsHistory([]);
        setGridMetrics({
          total_load: 0,
          total_capacity: 0,
          total_curtailed_kw: 0,
          economic_loss: 0
        });
      },
      'Simulation reset to initial grid state.'
    );

  const applyWeatherByLocation = () =>
    runAction(
      'weather',
      async () => {
        if (!weatherDistrict) {
          throw new Error('Please enter a district name.');
        }
        
        // Fetch up to 10 results to allow for fuzzy matching and state filtering
        const geocodeResponse = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(weatherDistrict)}&count=10`);
        const geocodeData = await geocodeResponse.json();
        
        if (!geocodeData.results || geocodeData.results.length === 0) {
          throw new Error(`Could not find district '${weatherDistrict}'. Please check the spelling.`);
        }
        
        let targetLocation = geocodeData.results[0];
        
        // If user provided a state, try to find a result that matches the state (admin1)
        if (weatherState) {
          const stateMatch = geocodeData.results.find(res => 
            res.admin1 && res.admin1.toLowerCase().includes(weatherState.toLowerCase().trim())
          );
          
          if (stateMatch) {
            targetLocation = stateMatch;
          } else {
            throw new Error(`Found district '${targetLocation.name}', but not in state '${weatherState}'. Please check spelling.`);
          }
        }
        
        const { latitude, longitude, name, admin1 } = targetLocation;
        const displayCity = admin1 ? `${name}, ${admin1}` : name;
        
        const response = await fetch(`${API_BASE}/weather-stress`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ city: displayCity, lat: latitude, lon: longitude })
        });
        
        if (!response.ok) {
          throw new Error(`Failed to fetch weather for ${displayCity}.`);
        }
        
        const data = await response.json();
        return { ...data, city: displayCity };
      },
      (result) => `Weather simulation applied: ${result.temperature}°C in ${result.city}.`
    );

  const applyManualWeather = () =>
    runAction(
      'weather',
      async () => {
        if (manualTemperature === '') {
          throw new Error('Please enter a valid temperature.');
        }
        const response = await fetch(`${API_BASE}/weather-stress`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ city: 'Manual Entry', temperature: Number(manualTemperature) })
        });
        if (!response.ok) {
          throw new Error(`Failed to apply manual temperature.`);
        }
        const data = await response.json();
        return data;
      },
      (result) => `Weather simulation applied manually: ${result.temperature}°C.`
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
        <div className="weather-controls">
          <div className="weather-group">
            <select value={weatherState} onChange={(e) => setWeatherState(e.target.value)} disabled={isBusy}>
              <option value="">Select State</option>
              {INDIAN_STATES.map(state => (
                <option key={state} value={state}>{state}</option>
              ))}
            </select>
            <input type="text" placeholder="District" value={weatherDistrict} onChange={(e) => setWeatherDistrict(e.target.value)} disabled={isBusy} />
            <button type="button" onClick={applyWeatherByLocation} disabled={isBusy || !weatherDistrict}>🌍 Analyze</button>
          </div>
          <div className="weather-group">
            <input type="number" placeholder="Temp °C" value={manualTemperature} onChange={(e) => setManualTemperature(e.target.value)} disabled={isBusy} style={{width: '90px'}} />
            <button type="button" onClick={applyManualWeather} disabled={isBusy || manualTemperature === ''}>⚙️ Set Temp</button>
          </div>
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
            <MapContainer center={[11.0168, 76.9558]} zoom={13} style={{ width: '100%', height: '100%', zIndex: 1 }} cursor="crosshair">
              <MapClickTracker />
              <TileLayer
                url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
                attribution='&copy; <a href="https://carto.com/">CartoDB</a>'
              />
              
              {newTxLat && newTxLon && (
                <CircleMarker center={[newTxLat, newTxLon]} radius={10} pathOptions={{ fillColor: '#f59e0b', color: '#0f172a', weight: 2, fillOpacity: 0.9, dashArray: '3, 3' }}>
                  <LeafletTooltip permanent direction="top" offset={[0, -10]}>📍 New Node Preview</LeafletTooltip>
                </CircleMarker>
              )}
              
              {elements.filter(el => el.data.source && el.data.target).map((edge, idx) => {
                const sourceNode = transformers.find(t => t.id === edge.data.source);
                const targetNode = transformers.find(t => t.id === edge.data.target);
                if (sourceNode && targetNode && sourceNode.lat && targetNode.lat) {
                  const isOffline = sourceNode.status === 'OFFLINE' || targetNode.status === 'OFFLINE';
                  return (
                    <Polyline 
                      key={`edge-${idx}`} 
                      positions={[
                        [sourceNode.lat, sourceNode.lon], 
                        [targetNode.lat, targetNode.lon]
                      ]}
                      pathOptions={{ color: isOffline ? '#ef4444' : '#3b82f6', weight: 4, opacity: 0.8, dashArray: isOffline ? '5, 8' : null }}
                    />
                  );
                }
                return null;
              })}

              {transformers.map(tx => {
                if (!tx.lat || !tx.lon) return null;
                const isOnline = tx.status === 'ONLINE';
                const loadPercent = tx.max > 0 ? Math.round((tx.load / tx.max) * 100) : 0;
                return (
                  <CircleMarker 
                    key={tx.id} 
                    center={[tx.lat, tx.lon]}
                    radius={14}
                    pathOptions={{
                      fillColor: isOnline ? '#10b981' : '#ef4444',
                      color: '#0f172a',
                      weight: 3,
                      fillOpacity: 1
                    }}
                  >
                    <LeafletTooltip direction="top" offset={[0, -10]} opacity={1}>
                      <strong>{tx.id}</strong><br/>
                      Status: {tx.status}<br/>
                      Load: {tx.load} kW ({loadPercent}%)
                    </LeafletTooltip>
                  </CircleMarker>
                );
              })}
            </MapContainer>
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
                  <div className="transformer-top" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ fontSize: '1.1rem' }}>{tx.id}</strong>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <span className={tx.status === 'ONLINE' ? 'state-online' : 'state-offline'}>{tx.status}</span>
                      <button 
                        type="button" 
                        onClick={() => handleDeleteTransformer(tx.id)} 
                        disabled={isBusy}
                        style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '0 4px', fontSize: '1.2rem' }}
                        title={`Delete ${tx.id}`}
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                  <p>Current: {tx.load.toFixed(1)} kW / {tx.max.toFixed(1)} kW ({utilization}%)</p>
                  {tx.status === 'ONLINE' && tx.ttf !== null && tx.ttf !== undefined && (
                    <p style={{ color: tx.ttf < 30 ? '#ef4444' : '#eab308', fontWeight: 'bold', margin: '4px 0', fontSize: '13px' }}>
                      ⚠️ AI Prediction: Overload in {tx.ttf.toFixed(1)}s
                    </p>
                  )}
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
                    <button 
                      type="button" 
                      onClick={() => applyPowerControls(tx.id, currentValue)}
                      disabled={isBusy}
                      style={{ marginLeft: '8px', padding: '4px 12px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                    >
                      Apply
                    </button>
                  </div>
                </article>
              );
            })}
          </div>

          <div className="grid-expansion" style={{ padding: '16px', background: '#f8fafc', borderTop: '1px solid #e2e8f0', borderBottom: '1px solid #e2e8f0' }}>
            <h3 style={{ margin: '0 0 12px 0', fontSize: '1.05rem', color: '#1e293b' }}>Grid Expansion Toolkit</h3>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
              <input type="text" placeholder="Name" value={newTxName} onChange={e => setNewTxName(e.target.value)} disabled={isBusy} style={{ width: '85px', padding: '6px' }} title="Transformer Name"/>
              <input type="number" placeholder="Cap (kW)" value={newTxCapacity} onChange={e => setNewTxCapacity(e.target.value)} disabled={isBusy} style={{ width: '85px', padding: '6px' }} title="Max Capacity (kW)"/>
              <select value={newTxParent} onChange={e => { setNewTxParent(e.target.value); setNewTxLat(''); setNewTxLon(''); }} disabled={isBusy} style={{ padding: '6px' }} title="Connect To">
                <option value="">Standalone (None)</option>
                {transformers.map(tx => <option key={`exp-${tx.id}`} value={tx.id}>{tx.id}</option>)}
              </select>
              <input type="number" placeholder="Lat (Click Map)" step="0.0001" value={newTxLat} onChange={e => setNewTxLat(e.target.value)} disabled={isBusy} style={{ width: '110px', padding: '6px' }} title="Latitude"/>
              <input type="number" placeholder="Lon (Click Map)" step="0.0001" value={newTxLon} onChange={e => setNewTxLon(e.target.value)} disabled={isBusy} style={{ width: '110px', padding: '6px' }} title="Longitude"/>
              <button type="button" onClick={handleAddTransformer} disabled={isBusy || !newTxName || !newTxLat} style={{ padding: '6px 12px', background: '#3b82f6', color: 'white', borderRadius: '4px', fontWeight: 'bold' }}>+ Deploy Node</button>
            </div>
            
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '12px', borderTop: '1px dashed #cbd5e1', paddingTop: '12px' }}>
              <strong style={{ fontSize: '0.95rem', color: '#475569' }}>Link Existing Nodes:</strong>
              <select value={linkSource} onChange={e => setLinkSource(e.target.value)} disabled={isBusy} style={{ padding: '6px' }}>
                <option value="">Source Node</option>
                {transformers.map(tx => <option key={`src-${tx.id}`} value={tx.id}>{tx.id}</option>)}
              </select>
              <span>↔️</span>
              <select value={linkTarget} onChange={e => setLinkTarget(e.target.value)} disabled={isBusy} style={{ padding: '6px' }}>
                <option value="">Target Node</option>
                {transformers.map(tx => <option key={`tgt-${tx.id}`} value={tx.id}>{tx.id}</option>)}
              </select>
              <button type="button" onClick={handleLinkTransformers} disabled={isBusy || !linkSource || !linkTarget || linkSource === linkTarget} style={{ padding: '6px 12px', background: '#8b5cf6', color: 'white', borderRadius: '4px', fontWeight: 'bold' }}>🔗 Link</button>
            </div>
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
                    <span className="event-time">{new Date(event.timestamp).toLocaleTimeString()}</span>
                    <span className="event-message">{event.message}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      </main>

      <section className="panel" style={{ maxWidth: '1200px', margin: '14px auto', padding: '16px' }}>
        <h2 style={{ padding: '0 0 12px 0', marginBottom: '8px' }}>Live Load vs. Capacity</h2>
        <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
          
          <div style={{ flex: '1 1 100%', height: '260px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={metricsHistory} margin={{ top: 5, right: 20, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorLoad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8}/>
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="colorCap" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="time" tick={{fontSize: 12, fill: '#64748b'}} />
                <YAxis tick={{fontSize: 12, fill: '#64748b'}} />
                <Tooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                <Area type="monotone" dataKey="capacity" stroke="#10b981" fillOpacity={1} fill="url(#colorCap)" name="Grid Capacity (kW)" isAnimationActive={false} />
                <Area type="monotone" dataKey="load" stroke="#ef4444" fillOpacity={1} fill="url(#colorLoad)" name="Total Load (kW)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

    </div>
  );
}

export default App;
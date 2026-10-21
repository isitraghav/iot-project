// Static shell; public/app.js and public/radar.js render all data into it.
const ICONS: Record<string, React.ReactNode> = {
  fleet: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.8" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.8" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.8" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.8" /></>,
  audience: <path d="M5 20v-7M12 20V5M19 20v-10" />,
  live: <><circle cx="12" cy="12" r="1.6" /><path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4" /></>,
  retention: <path d="M4.5 12a7.5 7.5 0 0 1 13.2-4.9M19.5 12a7.5 7.5 0 0 1-13.2 4.9M18 3.5v4h-4M6 20.5v-4h4" />,
  devices: <><path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1 1 0 0 1 0 1.4l-7.3 7.3a1 1 0 0 1-1.4 0z" /><circle cx="8" cy="8" r="1.4" /></>,
  settings: <><path d="M4 7h9M18 7h2M4 17h3M12 17h8" /><circle cx="15.5" cy="7" r="2.3" /><circle cx="9.5" cy="17" r="2.3" /></>,
}
const Icon = ({ name }: { name: string }) => (
  <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>
)

const NAV: [string, string][] = [
  ['fleet', 'Fleet'], ['audience', 'Audience'], ['live', 'Live'],
  ['retention', 'Retention'], ['devices', 'Devices'], ['settings', 'Settings'],
]

const Seg = ({ id, attr, items, active }: { id: string; attr: string; items: [string, string][]; active: string }) => (
  <div className="seg" id={id} role="radiogroup">
    <span className="seg-thumb" aria-hidden="true" />
    {items.map(([v, label]) => (
      <button key={v} type="button" role="radio" aria-checked={v === active} {...{ [`data-${attr}`]: v }} className={v === active ? 'active' : ''}>{label}</button>
    ))}
  </div>
)
const RANGES: [string, string][] = [['1h', '1H'], ['today', 'Today'], ['24h', '24H'], ['7d', '7D'], ['30d', '30D']]

export default function Page() {
  return (
    <div className="app">
      <aside className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="10.5" rx="2.2" /><path d="M8.5 15v4.5M15.5 15v4.5" /></svg>
          </span>
          <div className="brand-txt">
            <div className="brand-name" id="orgName">Billboard Fleet</div>
            <div className="brand-sub" id="fleetHealthSub">Connecting…</div>
          </div>
        </div>
        <nav className="nav" role="tablist">
          {NAV.map(([id, label]) => (
            <button key={id} type="button" role="tab" data-page={id} className={id === 'fleet' ? 'active' : ''}>
              <Icon name={id} /><span>{label}</span>{id === 'fleet' && <span className="badge hidden" id="issueBadge" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button type="button" className="ghost-btn" id="themeBtn" aria-label="Switch appearance">
            <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" /></svg>
            <span>Appearance</span><span className="muted" id="themeLabel">Auto</span>
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="toolbar">
          <h1 className="toolbar-title" id="toolbarTitle">Fleet</h1>
          <button type="button" className="scope-btn" id="scopeBtn" aria-haspopup="listbox" aria-label="Choose billboard">
            <span className="status-dot" id="scopeDot" />
            <span id="scopeName">All billboards</span>
            <svg className="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5" /></svg>
          </button>
          <div className="toolbar-right">
            <span className="live-pill" id="statusPill"><span className="status-dot" /><span className="txt">Connecting…</span></span>
          </div>
        </header>

        <main className="content">
          {/* FLEET */}
          <section className="page active" id="page-fleet" aria-label="Fleet">
            <div className="page-head">
              <div>
                <h2 className="display">Fleet</h2>
                <p className="lede" id="fleetLede">Every billboard sensor, its health and who it&rsquo;s reaching.</p>
              </div>
              <button type="button" className="btn primary" id="addSensorBtn">
                <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>Add billboard
              </button>
            </div>
            <div className="fleet-summary" id="fleetSummary" />
            <div id="attention" />
            <div className="toolbar-row">
              <h3 className="section-title">Billboards</h3>
              <div className="filters">
                <input type="search" id="fleetSearch" placeholder="Search name or location" aria-label="Search billboards" />
                <Seg id="fleetFilter" attr="filter" active="all" items={[['all', 'All'], ['attention', 'Needs attention'], ['online', 'Online'], ['offline', 'Offline']]} />
                <Seg id="fleetView" attr="view" active="grid" items={[['grid', 'Cards'], ['table', 'Table']]} />
              </div>
            </div>
            <div id="fleetList" />
          </section>

          {/* AUDIENCE */}
          <section className="page" id="page-audience" aria-label="Audience">
            <div className="page-head">
              <div>
                <h2 className="display">Audience</h2>
                <p className="lede" id="audLede">Who passed, who looked, and for how long.</p>
              </div>
              <Seg id="rangeSeg" attr="range" active="24h" items={RANGES} />
            </div>
            <div className="kpis" id="kpis" />
            <div className="card hidden" id="compareCard">
              <div className="card-h"><h3>By billboard</h3><span className="muted small" id="compareNote" /></div>
              <div className="tbl-wrap"><table className="tbl" id="compareTable" /></div>
            </div>
            <div className="grid2">
              <div className="card">
                <div className="card-h"><h3>Estimated people</h3><button type="button" className="link" data-table="people">Show table</button></div>
                <p className="sub">Unique identities ÷ devices per person, with rotating addresses merged</p>
                <div className="chart"><canvas id="cPeople" /></div>
                <div className="tbl-wrap hidden" id="tbl-people" />
              </div>
              <div className="card">
                <div className="card-h"><h3>Viewers and passers-by</h3><button type="button" className="link" data-table="zones">Show table</button></div>
                <p className="sub">Viewers came within viewing distance; passers-by were only in sensor range</p>
                <div className="chart"><canvas id="cZones" /></div>
                <div className="tbl-wrap hidden" id="tbl-zones" />
              </div>
            </div>
            <div className="card">
              <div className="card-h"><h3>Weekly pattern</h3><span className="muted small">Average people per hour over the last 28 days</span></div>
              <div id="heatmap" className="heatmap" />
            </div>
            <div className="grid2">
              <div className="card">
                <div className="card-h"><h3>Dwell time</h3></div>
                <p className="sub">Visits by time spent in range</p>
                <div className="chart"><canvas id="cDwell" /></div>
              </div>
              <div className="card">
                <div className="card-h"><h3>Device mix</h3><span className="muted small" id="kindsNote" /></div>
                <p className="sub">Unique devices by vendor</p>
                <div className="chart"><canvas id="cVendors" /></div>
              </div>
            </div>
            <div className="grid2">
              <div className="card">
                <div className="card-h"><h3>Traffic by distance</h3><span className="muted small">Each device counted once, at its closest</span></div>
                <div className="rings-wrap"><svg id="rings" viewBox="0 0 420 420" role="img" aria-label="Unique devices by distance band" /></div>
                <div className="legend-ramp" id="ringsLegend" />
              </div>
              <div className="card">
                <div className="card-h"><h3>Device types by distance</h3></div>
                <div className="tbl-wrap"><table className="tbl cohort" id="typeBands" /></div>
              </div>
            </div>
          </section>

          {/* LIVE */}
          <section className="page" id="page-live" aria-label="Live">
            <div className="page-head">
              <div>
                <h2 className="display">Live</h2>
                <p className="lede">What the sensors hear right now. Updates every few seconds.</p>
              </div>
            </div>
            <div className="live-top">
              <div className="card hero">
                <div className="hero-lbl">People near <span id="liveScope">your billboards</span> now</div>
                <div className="hero-num" id="liveNow">–</div>
                <div className="zone-row" id="liveZones" />
              </div>
              <div className="card">
                <div className="card-h"><h3>Last 60 minutes</h3><span className="muted small">Devices per minute</span></div>
                <div className="chart short"><canvas id="cLive" /></div>
              </div>
            </div>
            <div className="radar-grid">
              <div className="card">
                <div className="card-h wrap">
                  <h3>Proximity radar</h3>
                  <div className="filters">
                    <Seg id="radarWin" attr="win" active="60" items={[['20', '20s'], ['60', '1m'], ['300', '5m']]} />
                    <label className="chk"><input type="checkbox" id="rWifi" defaultChecked /> WiFi</label>
                    <label className="chk"><input type="checkbox" id="rBle" defaultChecked /> BLE</label>
                    <label className="chk"><input type="checkbox" id="rAp" /> APs</label>
                    <label className="chk"><input type="checkbox" id="rLabels" defaultChecked /> Names</label>
                  </div>
                </div>
                <div className="radar-wrap" id="radarWrap"><canvas id="radarCanvas" /></div>
                <div className="type-legend" id="typeLegend" />
                <p className="sub foot">Distance comes from signal strength and is rough (±50%). Angle is arbitrary: one sensor can&rsquo;t tell direction. ● BLE ■ WiFi ◆ access point · hollow = excluded · ringed = tagged.</p>
              </div>
              <div className="card">
                <div className="card-h"><h3>Nearest</h3><span className="muted small" id="nearCount" /></div>
                <div className="tbl-wrap near-list"><table className="tbl" id="nearTable" /></div>
              </div>
            </div>
            <div className="card">
              <div className="card-h"><h3>In range now</h3><span className="muted small">Seen in the last 60 s, strongest first</span></div>
              <div className="tbl-wrap"><table className="tbl" id="liveTable" /></div>
            </div>
          </section>

          {/* RETENTION */}
          <section className="page" id="page-retention" aria-label="Retention">
            <div className="page-head">
              <div>
                <h2 className="display">Retention</h2>
                <p className="lede" id="retNote">How many come back.</p>
              </div>
              <Seg id="retSeg" attr="days" active="14" items={[['7', '7 days'], ['14', '14 days'], ['30', '30 days']]} />
            </div>
            <div className="kpis" id="retKpis" />
            <div className="card">
              <div className="card-h"><h3>New and returning devices</h3><span className="muted small">Per day</span></div>
              <div className="chart"><canvas id="cNewRet" /></div>
            </div>
            <div className="grid2">
              <div className="card">
                <div className="card-h"><h3>Cohort retention</h3><span className="muted small">% of each day&rsquo;s new devices seen N days later</span></div>
                <div className="tbl-wrap"><table className="tbl cohort" id="cohortTable" /></div>
              </div>
              <div className="card">
                <div className="card-h"><h3>Visit frequency</h3></div>
                <p className="sub">Distinct days each device was seen</p>
                <div className="chart"><canvas id="cFreq" /></div>
              </div>
            </div>
          </section>

          {/* DEVICES */}
          <section className="page" id="page-devices" aria-label="Devices">
            <div className="page-head">
              <div>
                <h2 className="display">Devices</h2>
                <p className="lede">Tag known devices. Ignore staff, your own phones and fixed devices so they don&rsquo;t count as audience.</p>
              </div>
              <a className="btn" id="exportBtn" href="/api/export/visits.csv?range=24h" download>
                <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14" /></svg>Export CSV
              </a>
            </div>
            <div className="filters bar">
              <input id="devSearch" type="search" placeholder="Search ID, tag, vendor, model" aria-label="Search devices" />
              <Seg id="devSeg" attr="range" active="24h" items={[['1h', '1H'], ['24h', '24H'], ['7d', '7D'], ['30d', '30D']]} />
              <select id="devKind" aria-label="Radio"><option value="">WiFi + BLE</option><option value="wifi">WiFi</option><option value="ble">BLE</option><option value="ap">Access points</option></select>
              <select id="devType" aria-label="Device type"><option value="">All types</option></select>
              <label className="chk"><input type="checkbox" id="taggedOnly" /> Tagged only</label>
              <span className="muted small" id="devCount" />
            </div>
            <div className="card flush">
              <div className="tbl-wrap tall"><table className="tbl sticky" id="devTable" /></div>
            </div>
          </section>

          {/* SETTINGS */}
          <section className="page" id="page-settings" aria-label="Settings">
            <div className="page-head">
              <div>
                <h2 className="display">Settings</h2>
                <p className="lede">Detection thresholds apply to every billboard and re-classify all history when saved.</p>
              </div>
            </div>
            <form id="settingsForm" className="settings" />
          </section>
        </main>
      </div>

      <div className="scrim" id="scrim" />
      <aside className="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle" aria-hidden="true">
        <div className="sheet-head">
          <div className="sheet-titles"><div className="sheet-eyebrow" id="sheetEyebrow" /><h3 id="sheetTitle" /></div>
          <button type="button" className="icon-btn" id="sheetClose" aria-label="Close">
            <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div className="sheet-body" id="sheetBody" />
      </aside>
      <div className="dialog-wrap" id="dialogWrap" aria-hidden="true">
        <div className="dialog" id="dialog" role="alertdialog" aria-modal="true" />
      </div>
      <div className="popover" id="popover" role="listbox" aria-hidden="true" />
      <div className="toasts" id="toasts" aria-live="polite" />
      <div id="tooltip" className="tooltip hidden" role="tooltip" />
    </div>
  )
}

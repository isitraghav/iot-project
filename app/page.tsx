export default function Page() {
  return (
    <>
      <header className="topbar">
        <div className="brand">
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="2"/><path d="M8 15v5M16 15v5" stroke="currentColor" strokeWidth="2"/></svg>
          <span id="bbName">Billboard</span>
        </div>
        <nav className="tabs" role="tablist">
          <button data-tab="overview" className="active">Overview</button>
          <button data-tab="radar">Radar</button>
          <button data-tab="live">Live</button>
          <button data-tab="retention">Retention</button>
          <button data-tab="devices">Devices &amp; Tags</button>
          <button data-tab="fleet">Fleet</button>
          <button data-tab="settings">Settings</button>
        </nav>
        <div className="right">
          <span id="status" className="pill"><span className="dot"></span><span className="txt">connecting…</span></span>
          <button id="themeBtn" className="icon-btn" title="Toggle theme" aria-label="Toggle theme">◐</button>
        </div>
      </header>

      <main>
        {/* OVERVIEW */}
        <section id="tab-overview" className="tab active">
          <div className="filters">
            <div className="seg" id="rangeSeg">
              <button data-range="1h">1h</button><button data-range="today">Today</button>
              <button data-range="24h" className="active">24h</button><button data-range="7d">7d</button><button data-range="30d">30d</button>
            </div>
            <span className="muted small" id="excludedNote"></span>
          </div>
          <div className="kpis" id="kpis"></div>
          <div className="grid2">
            <div className="card">
              <div className="card-h"><h3>Estimated people</h3><button className="link" data-table="people">Table</button></div>
              <p className="sub">Unique identities ÷ devices per person, with randomized WiFi MACs merged by probe fingerprint</p>
              <div className="chart"><canvas id="cPeople"></canvas></div>
              <div className="tbl-wrap hidden" id="tbl-people"></div>
            </div>
            <div className="card">
              <div className="card-h"><h3>Devices by zone</h3><button className="link" data-table="zones">Table</button></div>
              <p className="sub">Viewers are within viewing distance of the billboard; passers-by are only in range of the sensor</p>
              <div className="chart"><canvas id="cZones"></canvas></div>
              <div className="tbl-wrap hidden" id="tbl-zones"></div>
            </div>
          </div>
          <div className="card">
            <div className="card-h"><h3>Weekly traffic pattern</h3><span className="muted small">avg est. people per hour · last 28 days</span></div>
            <div id="heatmap" className="heatmap"></div>
          </div>
          <div className="grid2">
            <div className="card">
              <div className="card-h"><h3>Dwell time</h3></div>
              <p className="sub">Visits by time spent in range</p>
              <div className="chart"><canvas id="cDwell"></canvas></div>
            </div>
            <div className="card">
              <div className="card-h"><h3>Device mix</h3><span className="muted small" id="kindsNote"></span></div>
              <p className="sub">Unique devices by vendor</p>
              <div className="chart"><canvas id="cVendors"></canvas></div>
            </div>
          </div>
        </section>

        {/* RADAR */}
        <section id="tab-radar" className="tab">
          <div className="filters">
            <div className="seg" id="radarWin">
              <button data-win="20">20 s</button><button data-win="60" className="active">1 min</button><button data-win="300">5 min</button>
            </div>
            <label className="chk"><input type="checkbox" id="rWifi" defaultChecked /> WiFi</label>
            <label className="chk"><input type="checkbox" id="rBle" defaultChecked /> BLE</label>
            <label className="chk"><input type="checkbox" id="rAp" /> Access points</label>
            <label className="chk"><input type="checkbox" id="rLabels" defaultChecked /> Names</label>
          </div>
          <div className="radar-grid">
            <div className="card">
              <div className="card-h"><h3>Live proximity radar</h3><span className="muted small" id="radarMeta"></span></div>
              <div className="radar-wrap" id="radarWrap"><canvas id="radarCanvas"></canvas></div>
              <div className="type-legend" id="typeLegend"></div>
              <p className="sub">Distance is estimated from signal strength and is rough (±50%). Shape shows the radio: ● BLE, ■ WiFi, ◆ access point. Hollow = ignored/fixture, ringed = tagged. Click for details.</p>
            </div>
            <div className="card">
              <div className="card-h"><h3>Nearest devices</h3><span className="muted small" id="nearCount"></span></div>
              <div className="tbl-wrap near-list"><table className="tbl" id="nearTable"></table></div>
            </div>
          </div>
          <div className="filters">
            <div className="seg" id="bandSeg">
              <button data-range="1h">1h</button><button data-range="24h" className="active">24h</button><button data-range="7d">7d</button><button data-range="30d">30d</button>
            </div>
            <span className="muted small">Traffic by distance: each device counted once, at its closest approach</span>
          </div>
          <div className="grid2">
            <div className="card">
              <div className="card-h"><h3>Traffic rings</h3><span className="muted small">unique devices per distance band</span></div>
              <div className="rings-wrap"><svg id="rings" viewBox="0 0 420 420" role="img" aria-label="Unique devices by distance band"></svg></div>
              <div className="legend-ramp" id="ringsLegend"></div>
            </div>
            <div className="card">
              <div className="card-h"><h3>Device types by distance</h3></div>
              <div className="tbl-wrap"><table className="tbl cohort" id="typeBands"></table></div>
            </div>
          </div>
        </section>

        {/* LIVE */}
        <section id="tab-live" className="tab">
          <div className="live-top">
            <div className="card hero">
              <div className="muted small">Est. people near the billboard now</div>
              <div className="hero-num" id="liveNow">–</div>
              <div className="zone-row" id="liveZones"></div>
            </div>
            <div className="card">
              <div className="card-h"><h3>Sensor</h3></div>
              <dl className="kv" id="sensorInfo"></dl>
            </div>
          </div>
          <div className="card">
            <div className="card-h"><h3>Last 60 minutes</h3><span className="muted small">devices per minute</span></div>
            <div className="chart"><canvas id="cLive"></canvas></div>
          </div>
          <div className="card">
            <div className="card-h"><h3>In range now</h3><span className="muted small">seen in the last 60 s, strongest first</span></div>
            <div className="tbl-wrap"><table className="tbl" id="liveTable"></table></div>
          </div>
        </section>

        {/* RETENTION */}
        <section id="tab-retention" className="tab">
          <div className="filters">
            <div className="seg" id="retSeg">
              <button data-days="7">7 days</button><button data-days="14" className="active">14 days</button><button data-days="30">30 days</button>
            </div>
            <span className="muted small" id="retNote"></span>
          </div>
          <div className="kpis" id="retKpis"></div>
          <div className="card">
            <div className="card-h"><h3>New vs returning devices</h3></div>
            <div className="chart"><canvas id="cNewRet"></canvas></div>
          </div>
          <div className="grid2">
            <div className="card">
              <div className="card-h"><h3>Cohort retention</h3><span className="muted small">% of each day's new devices seen again N days later</span></div>
              <div className="tbl-wrap"><table className="tbl cohort" id="cohortTable"></table></div>
            </div>
            <div className="card">
              <div className="card-h"><h3>Visit frequency</h3></div>
              <p className="sub">Distinct days each device was seen</p>
              <div className="chart"><canvas id="cFreq"></canvas></div>
            </div>
          </div>
        </section>

        {/* DEVICES */}
        <section id="tab-devices" className="tab">
          <div className="filters">
            <input id="devSearch" type="search" placeholder="Search ID, label, vendor…" />
            <div className="seg" id="devSeg">
              <button data-range="1h">1h</button><button data-range="24h" className="active">24h</button><button data-range="7d">7d</button><button data-range="30d">30d</button>
            </div>
            <select id="devKind"><option value="">WiFi + BLE</option><option value="wifi">WiFi</option><option value="ble">BLE</option><option value="ap">Access points</option></select>
            <select id="devType"><option value="">All types</option></select>
            <label className="chk"><input type="checkbox" id="taggedOnly" /> Tagged only</label>
            <a className="btn" id="exportBtn" href="/api/export/visits.csv?range=7d">Export visits CSV</a>
          </div>
          <div className="card">
            <p className="sub">Give a device a label to tag it as a known user. Turn on <b>Ignore</b> for your own devices, staff, or fixed devices so they don't count as audience.</p>
            <div className="tbl-wrap"><table className="tbl" id="devTable"></table></div>
          </div>
        </section>

        {/* FLEET */}
        <section id="tab-fleet" className="tab">
          <div className="card narrow">
            <div className="card-h"><h3>Add billboard sensor</h3></div>
            <p className="sub">Each physical ESP32 is a sensor. Give it a name, then flash the downloaded <code>config.h</code> using <code>flash.bat</code>. WiFi and server URL are pre-configured.</p>
            <form id="fleetForm" className="form">
              <div className="row"><div><label htmlFor="fleetName">Billboard name</label><div className="help">e.g. "Main Street Billboard" or "Mall Entrance"</div></div>
                <input id="fleetName" type="text" placeholder="Billboard #1" required /></div>
              <div className="row"><div><label htmlFor="fleetLoc">Location (optional)</label><div className="help">Address or description</div></div>
                <input id="fleetLoc" type="text" placeholder="123 Main St" /></div>
              <div className="actions"><button className="primary" type="submit">Create &amp; download config.h</button><span className="muted small" id="fleetMsg"></span></div>
            </form>
          </div>
          <div className="card" id="fleetList">
            <div className="card-h"><h3>Your sensors</h3><button className="link" id="refreshFleet">Refresh</button></div>
            <div className="tbl-wrap"><table className="tbl" id="fleetTable"></table></div>
          </div>
        </section>

        {/* SETTINGS */}
        <section id="tab-settings" className="tab">
          <div className="card narrow">
            <h3>Detection &amp; estimation</h3>
            <form id="settingsForm" className="form"></form>
          </div>
        </section>
      </main>

      <aside id="drawer" className="drawer hidden" aria-hidden="true">
        <div className="drawer-inner">
          <div className="card-h"><h3 id="drawerTitle">Device</h3><button className="icon-btn" id="drawerClose" aria-label="Close">✕</button></div>
          <dl className="kv" id="drawerInfo"></dl>
          <h4>Signal, last 24 h</h4>
          <div className="chart small-chart"><canvas id="cDevice"></canvas></div>
          <h4>Recent visits</h4>
          <div className="tbl-wrap"><table className="tbl" id="drawerVisits"></table></div>
        </div>
      </aside>
      <div id="tooltip" className="tooltip hidden"></div>

    </>
  )
}

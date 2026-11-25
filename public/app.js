/* global Chart, UsageAggregate */
(function () {
    const A = UsageAggregate;

    const METRIC_LABELS = {
        total_characters: "Total characters",
        text_translation_characters: "Text translation characters",
        document_translation_characters: "Document translation characters",
        text_improvement_characters: "Text improvement (Write) characters",
        speech_to_text_minutes: "Speech-to-text minutes",
    };
    const SHORT_LABELS = {
        total_characters: "Total chars",
        text_translation_characters: "Text",
        document_translation_characters: "Documents",
        text_improvement_characters: "Write",
        speech_to_text_minutes: "STT minutes",
    };
    const MAX_SERIES = 8; // Categorical palette size; extra accounts fold into "Other".

    const state = {
        preset: "30d",
        start: null,
        end: null,
        granularity: "day",
        metric: "total_characters",
        data: null,
        loading: false,
    };
    const charts = { series: null, sparks: [] };

    const $ = (id) => document.getElementById(id);

    // ---------- Formatting ----------
    const fullFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
    const minutesFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
    const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

    function isMinutes(metric) {
        return metric === "speech_to_text_minutes";
    }
    function formatFull(value, metric) {
        return isMinutes(metric) ? `${minutesFmt.format(value)} min` : fullFmt.format(value);
    }
    function formatCompact(value, metric) {
        return isMinutes(metric) ? `${compactFmt.format(value)} min` : compactFmt.format(value);
    }
    function formatDate(date, opts) {
        return new Date(date + "T00:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", ...opts });
    }
    function bucketLabel(bucket) {
        if (state.granularity === "month") return formatDate(bucket, { month: "short", year: "numeric" });
        const label = formatDate(bucket, { month: "short", day: "numeric" });
        return state.granularity === "week" ? `Wk of ${label}` : label;
    }
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    }
    function cssVar(name) {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }

    // ---------- Dates ----------
    function todayUtc() {
        return new Date().toISOString().slice(0, 10);
    }
    function presetRange(preset) {
        const today = todayUtc();
        switch (preset) {
            case "7d":
                return [A.addDays(today, -6), today];
            case "90d":
                return [A.addDays(today, -89), today];
            case "mtd":
                return [today.slice(0, 8) + "01", today];
            case "last-month": {
                const firstThisMonth = today.slice(0, 8) + "01";
                const lastPrev = A.addDays(firstThisMonth, -1);
                return [lastPrev.slice(0, 8) + "01", lastPrev];
            }
            case "ytd":
                return [today.slice(0, 4) + "-01-01", today];
            case "12m":
                return [A.addDays(today, -(A.MAX_RANGE_DAYS - 1)), today];
            case "30d":
            default:
                return [A.addDays(today, -29), today];
        }
    }

    // ---------- URL state (so a view can be bookmarked) ----------
    function readUrl() {
        const p = new URLSearchParams(location.search);
        // Object.hasOwn / includes, so names like "constructor" don't pass.
        if (["day", "week", "month"].includes(p.get("granularity"))) state.granularity = p.get("granularity");
        if (Object.hasOwn(METRIC_LABELS, p.get("metric") || "")) state.metric = p.get("metric");
        if (A.isValidDate(p.get("start")) && A.isValidDate(p.get("end"))) {
            state.preset = "custom";
            state.start = p.get("start");
            state.end = p.get("end");
        } else {
            if (p.get("range")) state.preset = p.get("range");
            [state.start, state.end] = presetRange(state.preset);
        }
    }
    function writeUrl() {
        const p = new URLSearchParams();
        if (state.preset === "custom") {
            p.set("start", state.start);
            p.set("end", state.end);
        } else {
            p.set("range", state.preset);
        }
        p.set("granularity", state.granularity);
        p.set("metric", state.metric);
        history.replaceState(null, "", `?${p}`);
    }

    // ---------- Messages ----------
    function showMessages(items) {
        $("messages").innerHTML = items
            .map((m) => `<div class="message message-${m.kind}">${m.html}</div>`)
            .join("");
    }

    // ---------- Data ----------
    async function load(refresh) {
        const days = A.daysInclusive(state.start, state.end);
        if (state.start > state.end) {
            return showMessages([{ kind: "error", html: "The start date must be on or before the end date." }]);
        }
        if (days > A.MAX_RANGE_DAYS) {
            return showMessages([{ kind: "error", html: `The Admin API allows at most ${A.MAX_RANGE_DAYS} days per request. Pick a shorter range.` }]);
        }
        writeUrl();
        state.loading = true;
        $("refresh").disabled = true;
        $("refresh").textContent = "Loading…";
        try {
            const qs = new URLSearchParams({ start: state.start, end: state.end });
            if (refresh) qs.set("refresh", "1");
            const res = await fetch(`/api/usage?${qs}`);
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
            state.data = body;
            render();
        } catch (err) {
            showMessages([{ kind: "error", html: `Could not load usage: ${escapeHtml(err.message)}` }]);
        } finally {
            state.loading = false;
            $("refresh").disabled = false;
            $("refresh").textContent = "Refresh";
        }
    }

    // Accounts in config order, each with a stable color (color follows the account, never its rank).
    function accountsWithColor() {
        return state.data.accounts.map((account, i) => ({
            ...account,
            color: i < MAX_SERIES ? cssVar(`--series-${i + 1}`) : cssVar("--other"),
            total: A.totalOf(account.daily),
        }));
    }

    // ---------- Render ----------
    function render() {
        if (!state.data) return;
        const accounts = accountsWithColor();
        const ok = accounts.filter((a) => a.ok);
        const failed = accounts.filter((a) => !a.ok);
        const grand = ok.reduce((acc, a) => A.addMetrics(acc, a.total), A.emptyMetrics());

        renderHeader(accounts);
        const messages = [];
        if (failed.length) {
            messages.push({
                kind: "warning",
                html: `<strong>Totals exclude ${failed.length} account(s) that failed to load:</strong> ${failed
                    .map((a) => escapeHtml(a.name))
                    .join(", ")}. See the account panels below for details.`,
            });
        }
        showMessages(messages);

        document.querySelectorAll(".metric-name").forEach((el) => (el.textContent = `· ${METRIC_LABELS[state.metric]}`));
        $("summary-range").textContent = `· ${formatDate(state.start, { month: "short", day: "numeric", year: "numeric" })} – ${formatDate(state.end, { month: "short", day: "numeric", year: "numeric" })}`;

        renderStats(grand, ok.length);
        renderShare(ok, grand);
        renderSeries(accounts);
        renderAccounts(accounts);
    }

    function renderHeader(accounts) {
        const fetched = new Date(state.data.fetched_at).toLocaleString();
        $("subtitle").innerHTML =
            `${accounts.length} account(s) · last fetched ${escapeHtml(fetched)}` +
            (state.data.sample ? '<span class="badge badge-sample">Sample data</span>' : "");
    }

    function renderStats(grand, okCount) {
        $("stats").innerHTML = A.METRICS.map(
            (m) => `
            <button type="button" class="stat-card${m === state.metric ? " is-selected" : ""}" data-metric="${m}"
                title="${formatFull(grand[m], m)}" aria-pressed="${m === state.metric}">
                <div class="stat-label">${METRIC_LABELS[m]}</div>
                <div class="stat-value">${formatCompact(grand[m], m)}</div>
                <div class="stat-sub">${formatFull(grand[m], m)} · ${okCount} account(s)</div>
            </button>`
        ).join("");
        $("stats").querySelectorAll("[data-metric]").forEach((el) =>
            el.addEventListener("click", () => setMetric(el.dataset.metric))
        );
    }

    function renderShare(ok, grand) {
        const m = state.metric;
        const max = Math.max(...ok.map((a) => a.total[m]), 0);
        if (!ok.length) {
            $("share").innerHTML = '<p class="muted">No account data loaded.</p>';
            return;
        }
        $("share").innerHTML = ok
            .map((a) => {
                const pct = grand[m] ? (a.total[m] / grand[m]) * 100 : 0;
                const width = max ? (a.total[m] / max) * 100 : 0;
                return `<div class="share-row">
                    <div class="share-name"><span class="swatch" style="background:${a.color}"></span>${escapeHtml(a.name)}</div>
                    <div class="share-track"><div class="share-bar" style="width:${width}%;background:${a.color}"></div></div>
                    <div class="share-value">${formatFull(a.total[m], m)} · ${pct.toFixed(1)}%</div>
                </div>`;
            })
            .join("");
    }

    function isPartialBucket(bucket) {
        const g = state.granularity;
        if (g === "day") return false;
        const next = g === "week" ? A.addDays(bucket, 7) : A.bucketStart(A.addDays(bucket, 31), "month");
        const bucketEnd = A.addDays(next, -1);
        return bucket < state.start || bucketEnd > state.end;
    }

    function seriesData(accounts) {
        const buckets = A.bucketRange(state.start, state.end, state.granularity);
        let rows = accounts
            .filter((a) => a.ok)
            .map((a) => ({
                name: a.name,
                color: a.color,
                values: A.bucketDaily(a.daily, buckets, state.granularity).map((v) => v[state.metric]),
            }));
        if (rows.length > MAX_SERIES) {
            const keep = rows.slice(0, MAX_SERIES - 1);
            const rest = rows.slice(MAX_SERIES - 1);
            keep.push({
                name: `Other (${rest.length} accounts)`,
                color: cssVar("--other"),
                values: buckets.map((_, i) => rest.reduce((s, r) => s + r.values[i], 0)),
            });
            rows = keep;
        }
        return { buckets, rows };
    }

    function baseChartOptions() {
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: "index", intersect: false },
            color: cssVar("--text-secondary"),
            font: { family: "Roboto, system-ui, sans-serif" },
        };
    }

    function renderSeries(accounts) {
        const { buckets, rows } = seriesData(accounts);
        const m = state.metric;
        const labels = buckets.map((b) => bucketLabel(b) + (isPartialBucket(b) ? " (partial)" : ""));
        if (charts.series) charts.series.destroy();
        charts.series = null;
        $("series-empty").hidden = rows.length > 0;
        $("series-wrap").hidden = rows.length === 0;
        if (!rows.length) {
            $("series-table").innerHTML = "";
            return;
        }
        charts.series = new Chart($("series-chart"), {
            type: "bar",
            data: {
                labels,
                datasets: rows.map((r) => ({
                    label: r.name,
                    data: r.values,
                    backgroundColor: r.color,
                    borderColor: cssVar("--chart-surface"),
                    borderWidth: { top: rows.length > 1 ? 2 : 0 },
                    borderRadius: 2,
                    borderSkipped: "bottom",
                    maxBarThickness: 48,
                })),
            },
            options: {
                ...baseChartOptions(),
                scales: {
                    x: {
                        stacked: true,
                        grid: { display: false },
                        border: { color: cssVar("--axis") },
                        ticks: { color: cssVar("--text-muted"), maxRotation: 0, autoSkip: true, autoSkipPadding: 16 },
                    },
                    y: {
                        stacked: true,
                        beginAtZero: true,
                        grid: { color: cssVar("--grid") },
                        border: { display: false },
                        ticks: { color: cssVar("--text-muted"), callback: (v) => formatCompact(v, m) },
                    },
                },
                plugins: {
                    legend: {
                        position: "top",
                        align: "start",
                        labels: { color: cssVar("--text-secondary"), boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 2 },
                    },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => `${ctx.dataset.label}: ${formatFull(ctx.parsed.y, m)}`,
                            footer: (items) => `Total: ${formatFull(items.reduce((s, i) => s + i.parsed.y, 0), m)}`,
                        },
                    },
                },
            },
        });
        renderSeriesTable(buckets, labels, rows);
    }

    function renderSeriesTable(buckets, labels, rows) {
        const m = state.metric;
        const head = `<tr><th>Period</th>${rows.map((r) => `<th>${escapeHtml(r.name)}</th>`).join("")}<th>Total</th></tr>`;
        const body = buckets
            .map((_, i) => {
                const total = rows.reduce((s, r) => s + r.values[i], 0);
                return `<tr><td>${escapeHtml(labels[i])}</td>${rows.map((r) => `<td>${formatFull(r.values[i], m)}</td>`).join("")}<td>${formatFull(total, m)}</td></tr>`;
            })
            .join("");
        $("series-table").innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
    }

    function renderAccounts(accounts) {
        charts.sparks.forEach((c) => c.destroy());
        charts.sparks = [];
        const m = state.metric;
        const buckets = A.bucketRange(state.start, state.end, state.granularity);

        $("accounts").innerHTML = accounts
            .map((a, i) => {
                const head = `<div class="account-head">
                        <div class="account-name">${escapeHtml(a.name)}</div>
                        ${a.region ? `<span class="badge" title="Data region">${escapeHtml(a.region)}</span>` : ""}
                    </div>`;
                if (!a.ok) {
                    return `<article class="account-card has-error">${head}
                        <div class="account-error"><strong>Failed to load.</strong> ${escapeHtml(a.error)}</div>
                    </article>`;
                }
                return `<article class="account-card" style="--account-color:${a.color}">${head}
                    <div class="account-value" title="${formatFull(a.total[m], m)}">${formatCompact(a.total[m], m)}</div>
                    <div class="account-value-label">${METRIC_LABELS[m]}</div>
                    <div class="sparkline"><canvas id="spark-${i}" aria-label="${escapeHtml(a.name)} ${METRIC_LABELS[m]} over time"></canvas></div>
                    <dl class="account-metrics">
                        ${A.METRICS.map((k) => `<dt>${SHORT_LABELS[k]}</dt><dd>${formatFull(a.total[k], k)}</dd>`).join("")}
                    </dl>
                </article>`;
            })
            .join("");

        accounts.forEach((a, i) => {
            if (!a.ok) return;
            const values = A.bucketDaily(a.daily, buckets, state.granularity).map((v) => v[m]);
            charts.sparks.push(
                new Chart($(`spark-${i}`), {
                    type: "line",
                    data: {
                        labels: buckets.map(bucketLabel),
                        datasets: [{ data: values, borderColor: a.color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.25, fill: false }],
                    },
                    options: {
                        ...baseChartOptions(),
                        scales: { x: { display: false }, y: { display: false, beginAtZero: true } },
                        plugins: {
                            legend: { display: false },
                            tooltip: { displayColors: false, callbacks: { label: (ctx) => formatFull(ctx.parsed.y, m) } },
                        },
                    },
                })
            );
        });
    }

    // ---------- Controls ----------
    function syncControls() {
        document.querySelectorAll("#presets [data-preset]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.preset === state.preset)));
        document.querySelectorAll("#granularity [data-granularity]").forEach((b) =>
            b.setAttribute("aria-pressed", String(b.dataset.granularity === state.granularity))
        );
        $("start-date").value = state.start;
        $("end-date").value = state.end;
        $("metric").value = state.metric;
    }

    function setMetric(metric) {
        state.metric = metric;
        syncControls();
        writeUrl();
        render();
    }

    function bindControls() {
        $("metric").innerHTML = A.METRICS.map((m) => `<option value="${m}">${METRIC_LABELS[m]}</option>`).join("");
        const today = todayUtc();
        $("start-date").max = today;
        $("end-date").max = today;

        $("presets").addEventListener("click", (e) => {
            const preset = e.target.dataset && e.target.dataset.preset;
            if (!preset) return;
            state.preset = preset;
            [state.start, state.end] = presetRange(preset);
            syncControls();
            load(false);
        });
        ["start-date", "end-date"].forEach((id) =>
            $(id).addEventListener("change", () => {
                if (!$("start-date").value || !$("end-date").value) return;
                state.preset = "custom";
                state.start = $("start-date").value;
                state.end = $("end-date").value;
                syncControls();
                load(false);
            })
        );
        $("granularity").addEventListener("click", (e) => {
            const g = e.target.dataset && e.target.dataset.granularity;
            if (!g) return;
            state.granularity = g;
            syncControls();
            writeUrl();
            render();
        });
        $("metric").addEventListener("change", (e) => setMetric(e.target.value));
        $("refresh").addEventListener("click", () => load(true));

        // Re-render charts with the right palette when the OS theme changes.
        window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
    }

    readUrl();
    bindControls();
    syncControls();
    load(false);
})();

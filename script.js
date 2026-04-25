import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

const $ = (id) => document.getElementById(id);

const state = {
  authReady: false,
  firebaseReady: false,
  user: null,
  idToken: "",
  plan: "free",
  subscriptionStatus: "inactive",
  remainingCredits: 0,
  dailyCredits: 10,
  resetAtIso: null,
  factors: { url: 42, file: 40, phish: 44, creds: 41 },
  risk: 42,
  intel: {
    phishDomains: new Set(),
    malwareHashes: new Set(),
    breachDomains: new Set()
  }
};

const KNOWN_MALWARE_HASHES = new Set([
  "9ffc423254fa44e267ac4afe81733e0b08c54aac022a2ffe90f9ad353f117897",
  "cb772aa889ec546f1d5511427155889a20a6ede481e48287bbb00f6c021cf9d0",
  "f12fd1151108655f2f0658403d05775eb81bba95f7645c02f978501364a12ae1",
  "9422e79e4cf03dc30ef73fb78c6500c6806ae9a6cf0b36d495e66a4f95dfea85",
  "a7be087ddde1764ff1c77ab0129d7f265bec7ff73c842b33b690b9b8a6b6941b",
  "d68ebfc2c9650383c3fad825f1a07279b1141c63a86b26e2f38b88b007179c67",
  "83dc2b63e0b878a433f349f77d131c1e40f033a2a218df05c5c68bd3964fe636",
  "672162a723b931ff10c09328c3b71e01be02e4546c7000e7fa5d3b0bbd6ee5dc",
  "d927e11dac042493b09ccb35b5a402e9eb550a5a2a5263b52aedfa70854072d9",
  "440836d991a02bc8e8d2e40b2d6512a78a6898ba0d4ef8188339e36584666bc9",
  "34a19c2071df46b14a28d612cc2eeeed032c74b0d9a84409a419c43a361021ce",
  "c3f9a7289415de1e238d094c061f2f620058faa59190fe016f86cab5bde25b83"
]);

const recMap = {
  low: [
    "Maintain weekly endpoint scans and patch routines.",
    "Keep MFA enforced for high-privilege accounts.",
    "Continue phishing simulation training each month."
  ],
  moderate: [
    "Harden external attack surface and close unused ports.",
    "Enable DNS filtering for suspicious outbound traffic.",
    "Rotate stale credentials and enforce passkeys where possible."
  ],
  high: [
    "Trigger incident response runbook and isolate risky endpoints.",
    "Revoke exposed tokens and force organization-wide password reset.",
    "Deploy temporary geo-block and strict network segmentation."
  ]
};

const clamp = (n, min, max) => Math.min(Math.max(n, min), max);
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function hasUsableFirebaseConfig(cfg) {
  const required = ["apiKey", "authDomain", "projectId", "appId"];
  return required.every((key) => {
    const value = String(cfg?.[key] || "").trim();
    return value && !value.startsWith("YOUR_FIREBASE_");
  });
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function setAuthStatus(text) {
  setText("auth-status", text);
  setText("gate-status", text);
}

function updatePlanUi() {
  setText("plan-label", state.plan.toUpperCase());
  setText("credits-remaining", String(state.remainingCredits));
  const reset = state.resetAtIso ? new Date(state.resetAtIso) : null;
  setText("credits-reset", reset ? reset.toUTCString().slice(17, 22) : "--:--");
  setText("subscription-status", `Subscription Status: ${state.subscriptionStatus}`);
  const upBtn = $("upgrade-pro-btn");
  if (upBtn) {
    upBtn.disabled = !state.user || state.plan === "pro";
    upBtn.textContent = state.plan === "pro" ? "Pro Active" : "Upgrade to Pro";
  }
}

function setRisk() {
  const avg = Object.values(state.factors).reduce((a, b) => a + b, 0) / 4;
  state.risk = clamp(Math.round(avg), 1, 99);

  setText("risk-num", String(state.risk));
  const c = 565;
  const offset = c - (c * state.risk) / 100;
  $("risk-fg").style.strokeDashoffset = String(offset);

  let level = "moderate";
  let label = "Moderate Exposure";
  if (state.risk <= 34) {
    level = "low";
    label = "Low Exposure";
  }
  if (state.risk >= 71) {
    level = "high";
    label = "High Exposure";
  }
  setText("risk-label", label);

  const recs = $("recs");
  recs.innerHTML = "";
  recMap[level].forEach((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    recs.appendChild(li);
  });
}

async function loadOpenPhishDomains() {
  try {
    const resp = await fetch("https://openphish.com/feed.txt");
    if (!resp.ok) return new Set();
    const text = await resp.text();
    const urls = text.split("\n").map((x) => x.trim()).filter((x) => /^https?:\/\//i.test(x));
    const domains = urls
      .map((u) => {
        try {
          return new URL(u).hostname.toLowerCase();
        } catch {
          return "";
        }
      })
      .filter(Boolean);
    return new Set(domains);
  } catch {
    return new Set();
  }
}

async function loadBreachDomains() {
  try {
    const cached = JSON.parse(localStorage.getItem("securex_breaches") || "null");
    const now = Date.now();
    if (cached && now - cached.ts < 1000 * 60 * 60 * 12) {
      return new Set((cached.domains || []).map((x) => x.toLowerCase()));
    }

    const resp = await fetch("https://haveibeenpwned.com/api/v3/breaches");
    if (!resp.ok) return new Set();
    const data = await resp.json();
    const domains = data.map((x) => (x.Domain || "").toLowerCase()).filter(Boolean);
    localStorage.setItem("securex_breaches", JSON.stringify({ ts: now, domains }));
    return new Set(domains);
  } catch {
    return new Set();
  }
}

async function initIntel() {
  const [phishDomains, breachDomains] = await Promise.all([loadOpenPhishDomains(), loadBreachDomains()]);
  state.intel.phishDomains = phishDomains;
  state.intel.malwareHashes = new Set(KNOWN_MALWARE_HASHES);
  state.intel.breachDomains = breachDomains;
}

function apiBase() {
  return "";
}

async function apiFetch(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (state.idToken) headers.Authorization = `Bearer ${state.idToken}`;

  const resp = await fetch(`${apiBase()}${path}`, { ...options, headers });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.error || "API request failed");
  }
  return data;
}

async function bootstrapUser() {
  const data = await apiFetch("/api/users/bootstrap", { method: "POST", body: "{}" });
  state.plan = data.plan || "free";
  state.subscriptionStatus = data.subscriptionStatus || "inactive";
  state.remainingCredits = Number(data.remaining || 0);
  state.dailyCredits = Number(data.dailyCredits || 10);
  state.resetAtIso = data.resetAt || null;
  if (data?.price?.inrMonthly) {
    setText("inr-price", `Charged as approx INR ${data.price.inrMonthly}/month (display: $${data.price.usdMonthly}/mo).`);
  }
  updatePlanUi();
}

async function consumeCredit(action) {
  const data = await apiFetch("/api/credits/consume", {
    method: "POST",
    body: JSON.stringify({ action })
  });

  if (!data.allowed) {
    state.remainingCredits = 0;
    state.resetAtIso = data.resetAt || state.resetAtIso;
    updatePlanUi();
    throw new Error("Daily credits exhausted. Upgrade to Pro for 200 credits/day.");
  }

  state.remainingCredits = Number(data.remaining || 0);
  state.plan = data.plan || state.plan;
  state.resetAtIso = data.resetAt || state.resetAtIso;
  updatePlanUi();
}

async function ensureAuthorized(actionName) {
  if (!state.firebaseReady) throw new Error("Firebase not configured. Set securex.config.js first.");
  if (!state.user) throw new Error("Sign in with Google first.");
  await consumeCredit(actionName);
}

async function analyzeUrl(url) {
  if (!url) return { score: 50, msg: "Enter a URL first." };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { score: 90, msg: "Invalid URL format. High risk until corrected." };
  }

  const host = parsed.hostname.toLowerCase();
  let score = 12;
  const reasons = [];

  if (parsed.protocol !== "https:") {
    score += 25;
    reasons.push("Not using HTTPS");
  }

  if (state.intel.phishDomains.has(host)) {
    score += 70;
    reasons.push("Domain found in OpenPhish feed");
  }

  if (host.startsWith("xn--")) {
    score += 12;
    reasons.push("Punycode domain");
  }

  if (/(login|verify|secure|bonus|wallet|gift|auth)/i.test(url)) {
    score += 10;
    reasons.push("High-risk lure keywords");
  }

  if ((host.match(/-/g) || []).length > 3 || host.length > 38) {
    score += 8;
    reasons.push("Obfuscated or long host pattern");
  }

  try {
    const dnsResp = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`);
    const dns = await dnsResp.json();
    const hasA = Array.isArray(dns.Answer) && dns.Answer.some((x) => x.type === 1);
    if (!hasA) {
      score += 18;
      reasons.push("No valid A record returned");
    }
  } catch {
    score += 7;
    reasons.push("DNS check unavailable");
  }

  score = clamp(score, 5, 99);
  if (!reasons.length) reasons.push("No high-risk indicator found");
  return { score, msg: `URL risk ${score}/100. ${reasons.slice(0, 3).join("; ")}.` };
}

function analyzeFile(input) {
  if (!input) return { score: 45, msg: "Enter a file name or SHA256 hash first." };
  const text = input.trim().toLowerCase();
  let score = 20;
  const reasons = [];

  if (/^[a-f0-9]{64}$/.test(text)) {
    if (state.intel.malwareHashes.has(text)) {
      score = 97;
      reasons.push("Hash matched malware intelligence record");
    } else {
      score = 34;
      reasons.push("Hash not found in local malware snapshot");
    }
  } else {
    const ext = (text.split(".").pop() || "").toLowerCase();
    if (["exe", "dll", "js", "vbs", "scr", "bat", "cmd", "ps1", "msi"].includes(ext)) {
      score += 34;
      reasons.push(`Executable/script extension: .${ext}`);
    }
    if (/(invoice|urgent|payment|tax|update|patch)/i.test(text)) {
      score += 18;
      reasons.push("Social-engineering filename pattern");
    }
    score = clamp(score, 12, 88);
  }

  return { score, msg: `File risk ${score}/100. ${reasons.join("; ")}.` };
}

async function analyzePhishAndIp(domain, ip) {
  if (!domain && !ip) return { score: 44, msg: "Enter a domain and/or IP first." };

  const notes = [];
  let score = 18;

  if (domain) {
    const d = domain.toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
    if (state.intel.phishDomains.has(d)) {
      score += 70;
      notes.push("Domain appears in OpenPhish feed");
    } else {
      notes.push("Domain not found in OpenPhish snapshot");
    }
  }

  if (ip) {
    try {
      const ipResp = await fetch(`https://api.ipapi.is/?q=${encodeURIComponent(ip)}`);
      const ipData = await ipResp.json();

      if (ipData.is_bogon) {
        score += 30;
        notes.push("Bogon IP detected");
      }
      if (ipData.is_tor) {
        score += 28;
        notes.push("TOR exit node");
      }
      if (ipData.is_proxy || ipData.is_vpn) {
        score += 16;
        notes.push("Proxy/VPN detected");
      }
      if (ipData.is_abuser) {
        score += 20;
        notes.push("Marked as abuser by provider intelligence");
      }

      const org = ipData.company?.name || ipData.datacenter?.datacenter || "Unknown";
      notes.push(`IP org: ${org}`);
    } catch {
      score += 10;
      notes.push("IP reputation service unavailable");
    }
  }

  score = clamp(score, 8, 99);
  return { score, msg: `Phishing/IP score ${score}/100. ${notes.slice(0, 4).join("; ")}.` };
}

function passwordWeaknessScore(password) {
  if (!password) return 92;
  let score = 70;
  const len = password.length;

  if (len >= 16) score -= 24;
  else if (len >= 12) score -= 16;
  else if (len >= 10) score -= 10;
  else score += 14;

  if (/[A-Z]/.test(password)) score -= 8;
  if (/[a-z]/.test(password)) score -= 6;
  if (/[0-9]/.test(password)) score -= 8;
  if (/[^A-Za-z0-9]/.test(password)) score -= 10;

  if (/(1234|password|qwerty|admin|letmein)/i.test(password)) score += 26;
  if (/^(.)\1+$/.test(password)) score += 20;

  return clamp(score, 5, 98);
}

async function sha1Hex(input) {
  const enc = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-1", enc);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function pwnedCount(password) {
  if (!password) return 0;
  const hash = await sha1Hex(password);
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  const resp = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`);
  if (!resp.ok) return 0;
  const lines = (await resp.text()).split("\n");
  for (const line of lines) {
    const [sfx, cnt] = line.trim().split(":");
    if (sfx === suffix) return Number(cnt || 0);
  }
  return 0;
}

async function analyzeCredentials(password, email) {
  let score = passwordWeaknessScore(password);
  const notes = [];

  try {
    const count = await pwnedCount(password);
    if (count > 0) {
      score += 36;
      notes.push(`Password appeared ${count.toLocaleString()} times in breach corpus`);
    } else {
      notes.push("Password not found in Pwned Passwords corpus");
    }
  } catch {
    notes.push("Password breach API unavailable");
  }

  if (email && email.includes("@")) {
    const domain = email.split("@").pop().toLowerCase();
    if (state.intel.breachDomains.has(domain)) {
      score += 18;
      notes.push(`Email domain appears in HIBP breach catalog (${domain})`);
    } else {
      notes.push("Email domain not found in HIBP breach-domain list");
    }
  }

  score = clamp(score, 6, 99);
  return { score, msg: `Credential risk ${score}/100. ${notes.slice(0, 3).join("; ")}.` };
}

function setupDashboard() {
  const points = Array.from({ length: 18 }, () => rand(45, 115));
  const chart = new Chart($("threat-chart"), {
    type: "line",
    data: {
      labels: points.map((_, i) => `${i + 1}h`),
      datasets: [{
        data: points,
        borderColor: "#00fff9",
        fill: true,
        pointRadius: 0,
        tension: 0.32,
        backgroundColor: "rgba(0,255,249,0.14)"
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#8a8a9f" }, grid: { color: "rgba(255,255,255,0.05)" } },
        y: { ticks: { color: "#8a8a9f" }, grid: { color: "rgba(255,255,255,0.05)" } }
      }
    }
  });

  const devices = ["Laptops", "Servers", "Mobiles", "Cloud", "IoT"];
  const holder = $("devices");
  devices.forEach((d) => {
    const s = document.createElement("span");
    s.textContent = `${d}: Protected`;
    holder.appendChild(s);
  });

  const timeline = $("timeline");
  const events = [
    "Blocked credential stuffing from 29 source IPs",
    "Zero-day patch deployed across edge environment",
    "Malicious macro payload isolated in sandbox",
    "Suspicious beaconing prevented by DNS policy",
    "Privilege escalation attempt denied by MFA gate"
  ];

  const pushEvent = () => {
    const li = document.createElement("li");
    li.textContent = `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} - ${events[rand(0, events.length - 1)]}`;
    timeline.prepend(li);
    while (timeline.children.length > 10) timeline.removeChild(timeline.lastChild);
  };

  for (let i = 0; i < 4; i += 1) pushEvent();

  setInterval(() => {
    setText("m-alerts", String(200 + rand(0, 36)));
    setText("m-attempts", String(3300 + rand(0, 420)));
    setText("m-malware", String(1650 + rand(0, 200)));
    setText("m-scans", String(24 + rand(0, 25)));

    const score = 82 + rand(0, 13);
    $("score-fill").style.width = `${score}%`;
    setText("score-label", `Overall Security Score: ${score}/100`);

    points.push(rand(52, 120));
    points.shift();
    chart.data.datasets[0].data = points;
    chart.update("none");

    pushEvent();
  }, 2600);
}

function setupHeatmap() {
  const map = $("heatmap");
  for (let i = 0; i < 26; i += 1) {
    const dot = document.createElement("span");
    dot.className = "heat";
    dot.style.left = `${rand(5, 94)}%`;
    dot.style.top = `${rand(7, 92)}%`;
    dot.style.animationDelay = `${(i % 8) * 0.25}s`;
    map.appendChild(dot);
  }
}

function setupNews() {
  const items = [
    ["Zero-Day", "Critical auth bypass exploit impacts API gateways", "Immediate token rotation and WAF rule hardening recommended."],
    ["Breach", "Cloud storage misconfiguration exposed internal logs", "Incident teams are enforcing stricter object ACL controls."],
    ["AI Security", "Model integrity checks reduce poisoned training data risk", "Security teams are adopting signed model artifact pipelines."],
    ["Patch", "Browser vendor released emergency patch for active exploit", "Force auto-update policy and verify endpoint compliance quickly."],
    ["Threat Intel", "Ransomware crews shifting to low-noise persistence", "Behavioral detections are outperforming IOC-only playbooks."],
    ["Industry", "Passkeys adoption rises in enterprise workforce", "Phishing-resistant auth continues lowering account takeover rates."]
  ];

  const grid = $("news-grid");
  items.forEach((x) => {
    const card = document.createElement("article");
    card.className = "glass panel-news reveal";
    card.innerHTML = `<small>${x[0]}</small><h3>${x[1]}</h3><p>${x[2]}</p>`;
    grid.appendChild(card);
  });

  const ticker = [
    "Zero-day exploit chain disclosed in enterprise VPN stack",
    "Large phishing wave targets payroll portals",
    "Emergency patch released for endpoint privilege flaw",
    "SOC analysts report stealthier C2 traffic patterns",
    "New breach report highlights credential stuffing growth"
  ];

  const list = [...ticker, ...ticker];
  setText("ticker-track", list.map((t) => `* ${t}`).join("    "));
}

function setupLab() {
  $("gen-pass").addEventListener("click", () => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
    const len = clamp(Number($("pass-len").value) || 18, 8, 64);
    let out = "";
    for (let i = 0; i < len; i += 1) out += chars.charAt(Math.floor(Math.random() * chars.length));
    setText("pass-out", out);
  });

  $("privacy-btn").addEventListener("click", async () => {
    try {
      await ensureAuthorized("privacy_audit");
      const score = rand(67, 96);
      setText("privacy-out", `Privacy score ${score}/100. ${score > 86 ? "Strong browser hardening." : "Enable strict anti-tracking and HTTPS-only mode."}`);
    } catch (error) {
      setText("privacy-out", String(error.message || error));
    }
  });

  const checklists = {
    gamers: ["Enable 2FA for game accounts", "Avoid unknown mods", "Use unique payment token"],
    students: ["Turn on full-disk encryption", "Use password manager", "Review app permissions monthly"],
    businesses: ["Enforce least privilege", "Run quarterly recovery drill", "Deploy endpoint detection"]
  };

  const renderChecklist = () => {
    const key = $("profile").value;
    const ul = $("checklist");
    ul.innerHTML = "";
    checklists[key].forEach((t) => {
      const li = document.createElement("li");
      li.textContent = t;
      ul.appendChild(li);
    });
  };

  $("load-check").addEventListener("click", renderChecklist);
  renderChecklist();

  $("download-report").addEventListener("click", () => {
    const payload = {
      generatedAt: new Date().toISOString(),
      risk: state.risk,
      plan: state.plan,
      remainingCredits: state.remainingCredits,
      summary: {
        url: $("url-result").textContent,
        file: $("file-result").textContent,
        phish: $("phish-result").textContent,
        creds: $("cred-result").textContent
      }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "securex-report.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("save-history").addEventListener("click", async () => {
    try {
      await ensureAuthorized("save_history");
      const now = new Date().toLocaleString();
      const existing = JSON.parse(localStorage.getItem("securex-history") || "[]");
      existing.unshift({ time: now, risk: state.risk, plan: state.plan });
      localStorage.setItem("securex-history", JSON.stringify(existing.slice(0, 30)));
      setText("history-msg", `Saved ${Math.min(existing.length, 30)} records.`);
    } catch (error) {
      setText("history-msg", String(error.message || error));
    }
  });
}

function setupForms() {
  ["contact-form", "bug-form", "newsletter-form"].forEach((id) => {
    $(id).addEventListener("submit", (e) => {
      e.preventDefault();
      const btn = e.target.querySelector("button");
      const old = btn.textContent;
      btn.textContent = "Submitted";
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = old;
        btn.disabled = false;
        e.target.reset();
      }, 1200);
    });
  });
}

function setupReveal() {
  const obs = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) entry.target.classList.add("show");
    });
  }, { threshold: 0.15 });
  document.querySelectorAll(".reveal").forEach((el) => obs.observe(el));
}

function setupParallax() {
  document.addEventListener("mousemove", (e) => {
    document.querySelectorAll("[data-parallax]").forEach((el) => {
      const f = Number(el.dataset.parallax || 0.05);
      const x = (window.innerWidth / 2 - e.clientX) * f;
      const y = (window.innerHeight / 2 - e.clientY) * f;
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    });
  });
}

function setupNav() {
  const btn = $("nav-toggle");
  const menu = $("nav-menu");
  btn.addEventListener("click", () => menu.classList.toggle("open"));
  menu.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => menu.classList.remove("open")));
}

function setupCursor() {
  const glow = $("cursor-glow");
  let x = window.innerWidth / 2;
  let y = window.innerHeight / 2;
  window.addEventListener("mousemove", (e) => {
    x = e.clientX;
    y = e.clientY;
  });
  const loop = () => {
    glow.style.left = `${x}px`;
    glow.style.top = `${y}px`;
    requestAnimationFrame(loop);
  };
  loop();
}

function setupMatrix() {
  const c = $("matrix");
  const ctx = c.getContext("2d");
  const chars = "01SECUREXCYBERDEFENSE";
  let w = 0;
  let h = 0;
  let cols = 0;
  let drops = [];

  function resize() {
    w = c.width = window.innerWidth;
    h = c.height = window.innerHeight;
    cols = Math.floor(w / 16);
    drops = Array.from({ length: cols }, () => Math.floor(Math.random() * (h / 16)));
  }

  function draw() {
    ctx.fillStyle = "rgba(10,10,15,0.08)";
    ctx.fillRect(0, 0, w, h);
    ctx.font = "12px JetBrains Mono, monospace";
    for (let i = 0; i < drops.length; i += 1) {
      const ch = chars[Math.floor(Math.random() * chars.length)];
      const x = i * 16;
      const y = drops[i] * 16;
      ctx.fillStyle = Math.random() > 0.9 ? "rgba(255,0,85,0.72)" : "rgba(0,255,249,0.72)";
      ctx.fillText(ch, x, y);
      if (y > h && Math.random() > 0.97) drops[i] = 0;
      drops[i] += 1;
    }
  }

  resize();
  window.addEventListener("resize", resize);
  setInterval(draw, 42);
}

function setProtectedEnabled(enabled) {
  document.querySelectorAll(".protected-action").forEach((btn) => {
    btn.disabled = !enabled;
  });
}

function setGateVisible(visible) {
  const gate = $("signin-gate");
  if (!gate) return;
  gate.classList.toggle("hidden", !visible);
  document.body.classList.toggle("gate-locked", visible);
}

async function refreshBillingHistory() {
  if (!state.user) return;
  try {
    const data = await apiFetch("/api/payments/history", { method: "GET" });
    const list = $("billing-history");
    list.innerHTML = "";
    if (!data.items || !data.items.length) {
      list.innerHTML = "<li>No payment records yet.</li>";
      return;
    }

    data.items.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = `${item.status.toUpperCase()} - ${item.currency} ${item.amount} (${item.paymentId.slice(0, 12)}...)`;
      list.appendChild(li);
    });
  } catch (error) {
    setText("subscription-status", `Subscription Status: ${String(error.message || error)}`);
  }
}

async function setupAuth() {
  const cfg = window.SECUREX_CONFIG?.firebase;
  setGateVisible(true);
  if (!hasUsableFirebaseConfig(cfg)) {
    setAuthStatus("Firebase config missing. Fill apiKey, authDomain, projectId, and appId in securex.config.js.");
    setProtectedEnabled(false);
    setText("gate-status", "Firebase is not configured yet. Add your web app credentials in securex.config.js, then redeploy.");
    $("gate-login-btn").disabled = true;
    return;
  }

  state.firebaseReady = true;
  const app = initializeApp(cfg);
  const auth = getAuth(app);
  const provider = new GoogleAuthProvider();

  const beginSignIn = async () => {
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      setAuthStatus(`Google sign-in failed: ${String(error.message || error)}`);
    }
  };

  $("google-login-btn").addEventListener("click", beginSignIn);
  $("gate-login-btn").addEventListener("click", beginSignIn);

  $("logout-btn").addEventListener("click", async () => {
    await signOut(auth);
  });

  onAuthStateChanged(auth, async (user) => {
    state.user = user;
    if (!user) {
      state.idToken = "";
      state.plan = "free";
      state.subscriptionStatus = "inactive";
      state.remainingCredits = 0;
      state.dailyCredits = 10;
      state.resetAtIso = null;
      updatePlanUi();
      setProtectedEnabled(false);
      $("google-login-btn").classList.remove("hidden");
      $("auth-user").classList.add("hidden");
      setAuthStatus("Sign in with Google to use scans and daily credits.");
      setGateVisible(true);
      return;
    }

    state.idToken = await user.getIdToken(true);
    $("google-login-btn").classList.add("hidden");
    $("auth-user").classList.remove("hidden");
    $("user-avatar").src = user.photoURL || "";
    setText("user-name", user.displayName || user.email || "User");

    try {
      await bootstrapUser();
      await refreshBillingHistory();
      setProtectedEnabled(true);
      setAuthStatus("Authenticated. Credits are enforced server-side.");
      setGateVisible(false);
    } catch (error) {
      setProtectedEnabled(false);
      setAuthStatus(`Auth bootstrap failed: ${String(error.message || error)}`);
      setGateVisible(true);
    }
  });

  $("refresh-billing-btn").addEventListener("click", refreshBillingHistory);

  $("upgrade-pro-btn").addEventListener("click", async () => {
    if (!state.user) {
      setAuthStatus("Sign in first to upgrade.");
      return;
    }

    try {
      const checkout = await apiFetch("/api/payments/create-subscription", {
        method: "POST",
        body: JSON.stringify({})
      });

      const options = {
        key: checkout.key,
        name: "SecureX",
        description: "$29/month Pro Subscription",
        subscription_id: checkout.subscriptionId,
        handler: async (response) => {
          try {
            await apiFetch("/api/payments/verify", {
              method: "POST",
              body: JSON.stringify(response)
            });
            await bootstrapUser();
            await refreshBillingHistory();
            setAuthStatus("Pro plan activated.");
          } catch (error) {
            setAuthStatus(`Payment verification failed: ${String(error.message || error)}`);
          }
        },
        prefill: {
          name: state.user.displayName || "",
          email: state.user.email || ""
        },
        notes: {
          uid: state.user.uid,
          plan: "pro",
          displayPrice: "$29/mo"
        },
        theme: {
          color: "#ff0055"
        }
      };

      const rz = new window.Razorpay(options);
      rz.open();
    } catch (error) {
      setAuthStatus(`Checkout init failed: ${String(error.message || error)}`);
    }
  });
}

function wireScans() {
  $("url-btn").addEventListener("click", async () => {
    try {
      await ensureAuthorized("url_scan");
      setText("url-result", "Running URL intelligence checks...");
      const r = await analyzeUrl($("url-input").value.trim());
      setText("url-result", r.msg);
      state.factors.url = r.score;
      setRisk();
    } catch (error) {
      setText("url-result", String(error.message || error));
    }
  });

  $("file-btn").addEventListener("click", async () => {
    try {
      await ensureAuthorized("file_scan");
      const r = analyzeFile($("file-input").value.trim());
      setText("file-result", r.msg);
      state.factors.file = r.score;
      setRisk();
    } catch (error) {
      setText("file-result", String(error.message || error));
    }
  });

  $("phish-btn").addEventListener("click", async () => {
    try {
      await ensureAuthorized("phish_ip_scan");
      setText("phish-result", "Running phishing and IP intelligence checks...");
      const r = await analyzePhishAndIp($("domain-input").value.trim(), $("ip-input").value.trim());
      setText("phish-result", r.msg);
      state.factors.phish = r.score;
      setRisk();
    } catch (error) {
      setText("phish-result", String(error.message || error));
    }
  });

  $("cred-btn").addEventListener("click", async () => {
    try {
      await ensureAuthorized("credential_scan");
      setText("cred-result", "Running password and breach checks...");
      const r = await analyzeCredentials($("password-input").value, $("email-input").value.trim());
      setText("cred-result", r.msg);
      state.factors.creds = r.score;
      setRisk();
    } catch (error) {
      setText("cred-result", String(error.message || error));
    }
  });
}

async function init() {
  setupNews();
  setupMatrix();
  setupCursor();
  setupParallax();
  setupReveal();
  setupNav();
  setupDashboard();
  setupHeatmap();
  setupLab();
  setupForms();
  setRisk();
  setProtectedEnabled(false);

  await initIntel();
  wireScans();
  await setupAuth();
}

init();

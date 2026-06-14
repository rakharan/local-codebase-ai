# Deployment Recommendations — local-codebase-ai

_Written: 2026-06-12_

## Context

This stack consists of:
- **Node.js API server** — handles questions, retrieval, synthesis
- **Qdrant** — vector database for indexed code chunks
- **Ollama** — local LLM inference (chat + embedding)
- **Current models**: `qwen2.5-coder:3b` (chat), `nomic-embed-text` (embedding)

The main constraint for team use is **LLM inference speed**. Ollama processes one request at a time by default. With CPU-only inference, qwen3:8b takes 2-3 minutes per question — unusable for a team.

---

## Option 1 — Local Server (Recommended for most teams)

**Best for:** Small to medium teams, privacy-sensitive codebases, long-term cost efficiency.

Your internal company code never leaves your network. One-time hardware cost, zero ongoing cloud bill.

### Minimum spec (qwen3:8b, good quality, interactive speed)

| Component | Recommendation | Estimated cost |
|---|---|---|
| GPU | NVIDIA RTX 3090 (24GB VRAM) | $500–800 secondhand |
| RAM | 32GB DDR4/DDR5 | $80–120 |
| CPU | Ryzen 7 5700X or Intel i7-12700 | $150–200 |
| Storage | 500GB NVMe SSD | $50–80 |
| Motherboard + PSU | Depends on CPU | $150–200 |
| **Total** | | **~$1,000–1,400** |

**Why RTX 3090?** 24GB VRAM fits qwen3:8b (5.9GB) comfortably with room for larger models later. Available secondhand for $500-800. RTX 4090 is faster but more expensive ($1,200-1,500 secondhand).

**Performance:** qwen3:8b inference at ~15-30s/question — fast enough for interactive team use.

### Recommended spec (qwen3:14b or larger, higher quality)

| Component | Recommendation | Estimated cost |
|---|---|---|
| GPU | 2x RTX 3090 (48GB VRAM total) or RTX 4090 | $1,000–1,500 |
| RAM | 64GB DDR5 | $150–200 |
| CPU | Ryzen 9 7900X or Intel i9-13900 | $300–400 |
| Storage | 1TB NVMe SSD | $80–100 |
| Motherboard + PSU | High-end, 2x PCIe support if dual GPU | $300–400 |
| **Total** | | **~$1,800–2,600** |

### Setup steps

```bash
# 1. Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# 2. Pull models
ollama pull qwen3:8b
ollama pull nomic-embed-text

# 3. Install Qdrant via Docker
docker run -d -p 6333:6333 -v $(pwd)/qdrant_storage:/qdrant/storage qdrant/qdrant

# 4. Clone and configure the app
git clone <your-repo> local-codebase-ai
cd local-codebase-ai
cp .env.example .env
# Edit .env: set OLLAMA_URL, QDRANT_URL, CHAT_MODEL

# 5. Install dependencies and start
npm install
npm run start
```

### Network access for team

Expose the Node.js API server behind Nginx with basic auth:

```nginx
server {
    listen 443 ssl;
    server_name codebase-ai.yourcompany.internal;

    ssl_certificate     /etc/ssl/certs/internal.crt;
    ssl_certificate_key /etc/ssl/private/internal.key;

    auth_basic "Internal Tool";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://localhost:9191;
        proxy_read_timeout 300s;  # LLM inference can take time
    }
}
```

Or use a simple VPN (Tailscale) to expose the server to your team without opening ports.

---

## Option 2 — Vultr Cloud GPU

**Best for:** Teams that want cloud convenience without managing hardware.

| Instance | GPU | VRAM | RAM | Cost |
|---|---|---|---|---|
| Vultr A16 | NVIDIA A16 | 16GB | 30GB | ~$0.90/hr (~$480/month reserved) |
| Vultr A40 | NVIDIA A40 | 48GB | 30GB | ~$2.50/hr (~$900/month reserved) |

**Pros:** Easy to spin up, managed infrastructure, good network.  
**Cons:** Expensive long-term vs local, code leaves your network.

### Setup

Same as local server steps above, but on a Vultr GPU instance. Use Vultr's firewall to restrict access to your team's IP ranges.

---

## Option 3 — Hetzner (CPU, budget option)

**Best for:** Teams okay with `qwen2.5-coder:3b` speed, tight budget.

| Instance | CPU | RAM | Cost |
|---|---|---|---|
| CAX41 (ARM) | 16 cores | 32GB | ~€29/month |
| CCX43 (x86) | 8 cores | 32GB | ~€80/month |

No GPU — `qwen2.5-coder:3b` at ~30-60s/question is acceptable. `qwen3:8b` would be 2-3min, not great for a team.

---

## Option 4 — Hybrid (Local Ollama + Cloud API)

**Best for:** Teams where one dev machine is powerful enough to share.

- Run Ollama on a local machine with a good GPU
- Deploy Qdrant + Node.js API on a cheap VPS (Hetzner CX22, ~€5/month)
- API server proxies LLM calls to the local Ollama via a tunnel (Tailscale or ngrok)

**Pros:** Cheapest cloud bill, GPU stays local.  
**Cons:** Local machine must stay on during work hours, network latency between VPS and local.

---

## Model Quality vs Hardware Tradeoff

As you upgrade hardware, you unlock better models. Here's what each tier gets you:

| Model | VRAM needed | Quality | Speed (RTX 3090) | Notes |
|---|---|---|---|---|
| `qwen2.5-coder:3b` | ~2GB | ⭐⭐ | ~10s | Current default. Fast, weak synthesis |
| `qwen3:4b` | ~3GB | ⭐⭐⭐ | ~12s | Good middle ground |
| `qwen3:8b` | ~6GB | ⭐⭐⭐⭐ | ~20s | Noticeably better synthesis |
| `qwen3:14b` | ~10GB | ⭐⭐⭐⭐ | ~35s | Strong reasoning, good for complex flows |
| `qwen3:32b` | ~22GB | ⭐⭐⭐⭐⭐ | ~90s | Near-frontier quality, needs 24GB VRAM |
| `qwen3:32b` (Q8) | ~34GB | ⭐⭐⭐⭐⭐ | ~120s | Full quality, needs 2x GPU or 48GB VRAM |

> **Disclaimer:** Speed estimates above are rough approximations based on typical token generation rates (~50-80 tok/s for 14b Q4 on RTX 3090) and average answer lengths (~300-500 tokens), not measured benchmarks. Real performance depends on quantization level, prompt length, system load, and Ollama version. Actual times may be 2x faster or slower. To benchmark on your own hardware once set up:
> ```bash
> time ollama run qwen3:8b "explain what isignal is in one paragraph"
> ```

**Sweet spots:**
- **RTX 3090 (24GB):** Run `qwen3:32b` at Q4 quantization — very high quality at ~90s/question
- **2x RTX 3090 (48GB):** Run `qwen3:32b` at Q8 — near-frontier quality
- **RTX 4090 (24GB):** Same VRAM as 3090 but ~40% faster inference — best single-GPU option

### How to switch models

Edit `.env`:
```env
CHAT_MODEL=qwen3:14b
```

Or per-question override:
```bash
npm run ask "explain the flow" --chat-model qwen3:32b
```

Pull the model first:
```bash
ollama pull qwen3:14b
```

---

## Summary

| Option | Cost | Speed | Privacy | Effort |
|---|---|---|---|---|
| Local server (RTX 3090) | ~$1,200 one-time | ⚡⚡⚡ | ✅ On-prem | Medium setup |
| Vultr GPU | ~$480/month | ⚡⚡⚡ | ⚠️ Cloud | Easy |
| Hetzner CPU | ~€30-80/month | ⚡ | ⚠️ Cloud | Easy |
| Hybrid | ~€5/month cloud | ⚡⚡⚡ | ✅ LLM local | Medium |

**TL;DR:** For a small team with a private codebase, buy a secondhand RTX 3090 workstation (~$1,200 total), run everything locally, and use `qwen3:8b` or `qwen3:14b` as the default model. Pays for itself vs cloud GPU in 2-3 months, and your code never leaves the office.

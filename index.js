#!/usr/bin/env node

// Verso MCP Server
// Communicates with Claude Code via stdio (JSON-RPC / MCP protocol)
// Forwards tool calls to the Verso app via WebSocket

const WebSocket = require('ws')
const readline = require('readline')
const https = require('https')
const http = require('http')

const log = (...args) => process.stderr.write(`[verso-mcp] ${args.join(' ')}\n`)

// --- CLI Args ---
const args = process.argv.slice(2)
let API_TOKEN = ''
let SERVER_URL = 'https://useverso.app' // default production

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--token' && args[i + 1]) { API_TOKEN = args[++i]; continue }
  if (args[i].startsWith('--token=')) { API_TOKEN = args[i].split('=')[1]; continue }
  if (args[i] === '--url' && args[i + 1]) { SERVER_URL = args[++i]; continue }
  if (args[i].startsWith('--url=')) { SERVER_URL = args[i].split('=')[1]; continue }
  if (args[i] === '--help' || args[i] === '-h') {
    process.stderr.write(`
  Verso MCP Server

  Usage:
    verso-mcp --token=vrs_xxx
    verso-mcp --token=vrs_xxx --url=http://localhost:4444

  Options:
    --token   API token (get from useverso.app settings)
    --url     Server URL (default: https://useverso.app)
    --help    Show this help
`)
    process.exit(0)
  }
}

if (!API_TOKEN) {
  process.stderr.write(`[verso-mcp] Error: --token is required. Get your API token from useverso.app settings.\n`)
  process.exit(1)
}

// --- Derive WebSocket URL from server URL ---
function getWsUrl() {
  const url = new URL(SERVER_URL)
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${url.host}?token=${encodeURIComponent(API_TOKEN)}`
}

// --- Active project ---
let activeProjectId = null

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, SERVER_URL)
    const mod = url.protocol === 'https:' ? https : http
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_TOKEN}`,
      },
    }
    const req = mod.request(opts, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { resolve(data) }
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

// --- WebSocket Client ---
let ws = null
const pendingRequests = new Map()

function registerProject() {
  if (ws && ws.readyState === WebSocket.OPEN && activeProjectId) {
    ws.send(JSON.stringify({ type: 'register', projectId: activeProjectId }))
    log('Registered for project', activeProjectId)
  }
}

function connectWS() {
  const wsUrl = getWsUrl()
  ws = new WebSocket(wsUrl)

  ws.on('open', () => {
    log('Connected to Verso')
    registerProject()
  })

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.id && pendingRequests.has(msg.id)) {
        const { resolve } = pendingRequests.get(msg.id)
        pendingRequests.delete(msg.id)
        resolve(msg)
      }
    } catch (e) {
      log('Parse error:', e.message)
    }
  })

  ws.on('close', () => {
    log('Disconnected, reconnecting...')
    setTimeout(connectWS, 2000)
  })

  ws.on('error', (err) => {
    log('WebSocket error:', err.message)
  })
}

function sendToolCall(tool, args) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('Not connected to Verso. Make sure the server is running and your token is valid.'))
      return
    }

    const id = Math.random().toString(36).slice(2) + Date.now().toString(36)
    pendingRequests.set(id, { resolve, reject })

    ws.send(JSON.stringify({ id, tool, args }))

    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id)
        reject(new Error('Tool call timed out'))
      }
    }, 30000)
  })
}

// --- MCP Protocol Handler ---
function sendResponse(response) {
  const str = JSON.stringify(response)
  process.stdout.write(str + '\n')
}

async function handleMessage(message) {
  const id = message.id
  const method = message.method || ''

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'verso', version: '0.2.0' },
        },
      }

    case 'notifications/initialized':
      return null

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: getToolDefinitions() },
      }

    case 'tools/call': {
      const params = message.params || {}
      const toolName = params.name || ''
      const toolArgs = params.arguments || {}

      // Local tools (API calls, not WebSocket)
      if (toolName === 'list_projects') {
        try {
          const projects = await apiRequest('GET', '/api/projects')
          const text = JSON.stringify(projects, null, 2)
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } }
        } catch (err) {
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true } }
        }
      }

      if (toolName === 'open_project') {
        activeProjectId = toolArgs.projectId
        registerProject()
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Switched to project ${activeProjectId}` }] } }
      }

      try {
        const response = await sendToolCall(toolName, toolArgs)
        const result = response.result

        // Screenshot response
        if (result && result._screenshot && result.data) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'image', data: result.data, mimeType: 'image/png' }],
            },
          }
        }

        const text = typeof result === 'string' ? result : JSON.stringify(result)
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text }] },
        }
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true,
          },
        }
      }
    }

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }

    default:
      if (id) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        }
      }
      return null
  }
}

// --- Tool Definitions ---
function getToolDefinitions() {
  return [
    {
      name: 'write_html',
      description: `You are an elite mobile app designer creating world-class, production-quality app screens.
Write standalone HTML using Tailwind CSS v4 utility classes + Iconify icons.
Your designs MUST look like premium, polished REAL production apps (Airbnb, Uber, Spotify, Revolut, etc.) — never wireframes or prototypes.

The renderer pre-loads: Tailwind CSS v4 (browser CDN), Iconify, Google Fonts preconnect.

=== DESIGN TOKEN SYSTEM ===
EVERY screen MUST begin with a Google Fonts <link> tag and a <style type="text/tailwindcss"> block that defines your design tokens.
Choose a cohesive, intentional color palette for the app. Example:

<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style type="text/tailwindcss">
  @theme inline {
    --color-background: var(--background);
    --color-foreground: var(--foreground);
    --color-primary: var(--primary);
    --color-primary-foreground: var(--primary-foreground);
    --color-secondary: var(--secondary);
    --color-secondary-foreground: var(--secondary-foreground);
    --color-muted: var(--muted);
    --color-muted-foreground: var(--muted-foreground);
    --color-accent: var(--accent);
    --color-accent-foreground: var(--accent-foreground);
    --color-destructive: var(--destructive);
    --color-card: var(--card);
    --color-card-foreground: var(--card-foreground);
    --color-border: var(--border);
    --color-input: var(--input);
    --color-ring: var(--ring);
    --font-font-sans: var(--font-sans);
    --font-font-heading: var(--font-heading);
    --radius-sm: calc(var(--radius) - 4px);
    --radius-md: calc(var(--radius) - 2px);
    --radius-lg: var(--radius);
    --radius-xl: calc(var(--radius) + 4px);
  }
  :root {
    --background: #FFFFFF;
    --foreground: #1A1C1E;
    --primary: #FF6B35;
    --primary-foreground: #FFFFFF;
    --secondary: #F5F7F9;
    --secondary-foreground: #1A1C1E;
    --muted: #F5F7F9;
    --muted-foreground: #8A9198;
    --accent: #FFF0F0;
    --accent-foreground: #C81E1E;
    --destructive: #EF4444;
    --card: #FFFFFF;
    --card-foreground: #1A1C1E;
    --border: #F0F2F5;
    --input: #F5F7F9;
    --ring: #FF6B35;
    --font-sans: "Plus Jakarta Sans";
    --font-heading: "Plus Jakarta Sans";
    --radius: 1rem;
  }
</style>

Customize ALL colors to match the app's brand/mood. Be creative with palettes — don't default to blue.
For dark themes, invert: --background: #0A0A0A, --foreground: #FAFAFA, --card: #1C1C1E, etc.

=== ICON SYNTAX ===
Use Iconify with the Solar icon set (recommended — beautiful, consistent):
<iconify-icon icon="solar:home-2-bold" class="size-6"></iconify-icon>
<iconify-icon icon="solar:heart-linear" class="size-5"></iconify-icon>
<iconify-icon icon="solar:magnifer-linear" class="size-5"></iconify-icon>

Use bold/filled variants for active/selected states, linear/outline for inactive.
Other great sets: lucide, ph (Phosphor), mdi, tabler, fluent.

=== SCREEN STRUCTURE ===
IMPORTANT: The renderer is an iframe sized to the phone frame (393x852). Use w-full, NOT max-w-md. The iframe IS the phone viewport.

<div class="flex flex-col min-h-screen bg-background text-foreground font-sans w-full relative overflow-hidden pb-20">
  <!-- Status bar -->
  <!-- Header -->
  <!-- Scrollable content -->
  <!-- Tab bar at bottom -->
</div>

=== IMAGES ===
NEVER use emoji as image placeholders. Use real photos:
- Avatars: https://i.pravatar.cc/SIZE?u=UNIQUE_NAME
- Products/Content: https://picsum.photos/W/H?random=N
- Specific: https://images.unsplash.com/photo-PHOTO_ID?w=W&h=H&fit=crop
All images: object-cover, proper border-radius, aspect ratios.

=== QUALITY RULES ===
1. Study real apps. Your design must be indistinguishable from a shipping product.
2. Visual hierarchy: font-bold for titles, font-semibold for labels, font-medium for secondary, regular for body.
3. Spacing: px-6 for screen padding. gap-2/3/4 for flex items. Generous whitespace.
4. Icons: size-4 (12px), size-5 (20px), size-6 (24px). Consistent within context.
5. Borders: border-border/50 (subtle). Never harsh borders.
6. Shadows: shadow-sm for cards. Never heavy shadows.
7. Backdrop blur: backdrop-blur-md for overlays and tab bars.
8. Color with intention: primary for CTAs, muted-foreground for secondary text, destructive for alerts.
9. Rounded corners: rounded-full for pills/avatars, rounded-2xl for cards, rounded-[20px]+ for large cards.
10. Touch targets: minimum 44px (h-11).
11. Text overflow: truncate for constrained text.
12. Consistent icon style: don't mix filled and outline in same context.
13. pb-24 on the main container when using a fixed tab bar.
14. Real data: use realistic names, prices, dates — never "Lorem ipsum".

If targetNodeId is provided, writes into that specific node instead of replacing the entire canvas.`,
      inputSchema: {
        type: 'object',
        properties: {
          html: {
            type: 'string',
            description: 'Complete HTML content including <style type="text/tailwindcss"> theme block, Google Font <link> tags, and body markup.',
          },
          platform: { type: 'string', enum: ['iPhone 16', 'Web'], description: "Target platform." },
          accentColor: { type: 'string', description: "Primary accent/brand color as hex." },
          fontFamily: { type: 'string', description: "Primary font family used." },
          theme: { type: 'string', enum: ['Light', 'Dark'], description: 'Color theme.' },
          iconLibrary: { type: 'string', description: "Icon set used." },
          targetNodeId: { type: 'string', description: 'Optional data-ps-id to write into instead of replacing entire canvas.' },
          changeDescription: {
            type: 'string',
            description: 'REQUIRED. Write a specific, meaningful commit-style message describing what you changed. Bad: "Design update". Good: "Add bottom tab bar with 4 tabs", "Change font to Google Sans".',
          },
        },
        required: ['html', 'platform', 'accentColor', 'fontFamily', 'theme', 'iconLibrary', 'changeDescription'],
      },
    },
    {
      name: 'get_tree',
      description: 'Get the current layer tree of the canvas. Returns a JSON array of nodes with id, tag, name, and children.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'set_text',
      description: 'Set the text content of a specific node by its data-ps-id.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'The data-ps-id of the target node' },
          text: { type: 'string', description: 'New text content' },
          changeDescription: { type: 'string', description: 'REQUIRED. Specific commit-style message. Bad: "Edit text". Good: "Change welcome heading to Turkish".' },
        },
        required: ['nodeId', 'text', 'changeDescription'],
      },
    },
    {
      name: 'set_style',
      description: 'Set inline CSS styles on a specific node by its data-ps-id.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'The data-ps-id of the target node' },
          css: { type: 'string', description: "CSS properties to apply (e.g. 'color: red; font-size: 16px')" },
          changeDescription: { type: 'string', description: 'REQUIRED. Specific commit-style message. Bad: "Edit style". Good: "Increase button border-radius to 16px".' },
        },
        required: ['nodeId', 'css', 'changeDescription'],
      },
    },
    {
      name: 'remove_node',
      description: 'Remove a node from the canvas by its data-ps-id.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'The data-ps-id of the node to remove' },
          changeDescription: { type: 'string', description: 'REQUIRED. Specific commit-style message. Bad: "Remove element". Good: "Remove promotional banner from homepage".' },
        },
        required: ['nodeId', 'changeDescription'],
      },
    },
    {
      name: 'get_screenshot',
      description: 'Capture a screenshot of the current canvas as a base64-encoded PNG image.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'create_screen',
      description: 'Create a new blank screen in the project.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the new screen' },
        },
      },
    },
    {
      name: 'list_screens',
      description: 'List all screens in the project with their indices and active status.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'switch_screen',
      description: 'Switch to a different screen by its index or name.',
      inputSchema: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'Index of the screen to switch to' },
          name: { type: 'string', description: 'Name of the screen to switch to' },
        },
      },
    },
    {
      name: 'get_design_settings',
      description: 'Returns the current design system state (theme, accentColor, iconLibrary, fontFamily, device, viewport).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_projects',
      description: 'List all your Verso projects. Returns project id, name, screen count, and last updated time.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'open_project',
      description: 'Connect to a specific Verso project by its ID. Must be called before using any design tools.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'The project ID to connect to (from list_projects)' },
        },
        required: ['projectId'],
      },
    },
  ]
}

// --- Start ---
connectWS()

const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', async (line) => {
  if (!line.trim()) return

  try {
    const message = JSON.parse(line)
    const response = await handleMessage(message)
    if (response) {
      sendResponse(response)
    }
  } catch (err) {
    log('Error processing message:', err.message)
  }
})

log('MCP server started')

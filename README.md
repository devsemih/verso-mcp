# verso-mcp

MCP server for [Verso](https://useverso.app) — AI-powered mobile app design tool.

Connects Claude Code to Verso so you can design mobile app screens with AI.

## Setup

1. Get your API token from [useverso.app](https://useverso.app) (click your avatar > copy API token)

2. Add to your Claude Code MCP config (`~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "verso": {
      "command": "npx",
      "args": ["verso-mcp", "--token=vrs_your_token_here"]
    }
  }
}
```

3. Restart Claude Code and start designing!

## Usage

Once connected, Claude can:

- **list_projects** — See all your Verso projects
- **open_project** — Connect to a specific project
- **write_html** — Design full screen layouts
- **get_tree** — Inspect the current design structure
- **set_text / set_style** — Make targeted edits
- **get_screenshot** — Capture the current design
- **create_screen / switch_screen** — Manage multiple screens

## Options

```
verso-mcp --token=vrs_xxx              # Connect to useverso.app
verso-mcp --token=vrs_xxx --url=URL    # Connect to custom server
```

## License

MIT

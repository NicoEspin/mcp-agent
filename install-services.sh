#!/bin/bash

# MCP Agent Services Installation Script
# This script installs systemd services for Playwright MCP server and NestJS application

set -e

echo "🚀 Installing MCP Agent systemd services..."

# Check if running as root or with sudo
if [[ $EUID -eq 0 ]]; then
    echo "❌ This script should NOT be run as root. Run as your user with sudo when needed."
    exit 1
fi

# Check if services exist
if [[ ! -f "playwright-mcp.service" ]] || [[ ! -f "mcp-agent.service" ]]; then
    echo "❌ Service files not found. Make sure playwright-mcp.service and mcp-agent.service exist in current directory."
    exit 1
fi

# Create systemd directory if it doesn't exist
echo "📁 Creating systemd user directory..."
mkdir -p ~/.config/systemd/user

# Copy service files
echo "📄 Installing service files..."
cp playwright-mcp.service ~/.config/systemd/user/
cp mcp-agent.service ~/.config/systemd/user/

# Reload systemd daemon
echo "🔄 Reloading systemd daemon..."
systemctl --user daemon-reload

# Enable services
echo "⚡ Enabling services..."
systemctl --user enable playwright-mcp.service
systemctl --user enable mcp-agent.service

# Enable lingering for user (allows services to run without login)
echo "🔐 Enabling user lingering..."
sudo loginctl enable-linger $USER

echo ""
echo "✅ Services installed successfully!"
echo ""
echo "🎛️  Service Management Commands:"
echo "   Start services:    systemctl --user start playwright-mcp mcp-agent"
echo "   Stop services:     systemctl --user stop playwright-mcp mcp-agent"
echo "   Restart services:  systemctl --user restart playwright-mcp mcp-agent"
echo "   Check status:      systemctl --user status playwright-mcp mcp-agent"
echo "   View logs:         journalctl --user -u playwright-mcp -u mcp-agent -f"
echo ""
echo "🚀 To start the services now, run:"
echo "   systemctl --user start playwright-mcp"
echo "   sleep 10"
echo "   systemctl --user start mcp-agent"
echo ""
echo "📋 To check if services are running:"
echo "   systemctl --user is-active playwright-mcp mcp-agent"
echo ""
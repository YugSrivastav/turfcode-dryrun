-- Turfcode Sleek Cyberpunk WezTerm Configuration
-- Place this file in ~/.wezterm.lua or launch WezTerm in this directory:
--   wezterm --config-file .wezterm.lua

local wezterm = require 'wezterm'
local config = wezterm.config_builder()

-- Color Scheme: Custom Turfcode Dark Slate & Cyber Lime
config.color_scheme = 'Tokyo Night'

config.colors = {
  foreground = '#E6EDF3',
  background = '#0D1117',
  cursor_bg = '#BBE15A',
  cursor_fg = '#000000',
  cursor_border = '#BBE15A',
  selection_bg = '#BBE15A',
  selection_fg = '#000000',
  ansi = {
    '#0D1117', -- Black
    '#FF7B72', -- Red
    '#BBE15A', -- Green (Turf Lime)
    '#F2CC60', -- Yellow
    '#79C0FF', -- Blue
    '#D2A8FF', -- Magenta
    '#56D364', -- Cyan
    '#E6EDF3', -- White
  },
  brights = {
    '#30363D', -- Bright Black
    '#FFA198', -- Bright Red
    '#D2F870', -- Bright Green
    '#E3B341', -- Bright Yellow
    '#A5D6FF', -- Bright Blue
    '#E8D9FF', -- Bright Magenta
    '#7EE787', -- Bright Cyan
    '#F0F6FC', -- Bright White
  },
}

-- Typography: High-legibility coding font
config.font = wezterm.font_with_fallback {
  'Cascadia Code',
  'JetBrains Mono',
  'Consolas',
  'Courier New',
}
config.font_size = 11.5
config.line_height = 1.15

-- Window Styling & Acrylic Transparency
config.window_background_opacity = 0.96
config.win32_system_backdrop = 'Acrylic'
config.window_padding = {
  left = 8,
  right = 8,
  top = 8,
  bottom = 8,
}
config.window_decorations = "RESIZE"

-- Performance & Rendering
config.front_end = "WebGpu"
config.max_fps = 120
config.animation_fps = 60
config.cursor_blink_rate = 600
config.default_cursor_style = 'BlinkingBar'

return config

# Sourced helpers for reading and writing $BRIEF_HOME/config.local.env.
# Values are stored single-quoted so characters such as & ; $ | ( ) never change how the file is loaded, and
# every write goes through a private (0600) temporary file, so a secret is never readable by other accounts.
config_file() { printf '%s' "${BRIEF_HOME:?BRIEF_HOME is not set}/config.local.env"; }

config_has() { grep -q "^$1=.\+" "$(config_file)" 2>/dev/null; }

config_set() {
  local key="$1" val="$2" f tmp
  case "$key" in *[!A-Z0-9_]*|"") echo "Invalid config key: $key" >&2; return 1 ;; esac
  case "$val" in *"'"*) echo "The value for $key contains a single quote, which is not supported." >&2; return 1 ;; esac
  f="$(config_file)"
  ( umask 077
    mkdir -p "$BRIEF_HOME"
    touch "$f"
    tmp="$(mktemp "$BRIEF_HOME/.config.XXXXXX")" || exit 1
    grep -v "^$key=" "$f" > "$tmp" || true
    printf "%s='%s'\n" "$key" "$val" >> "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$f" )
}

# rsync --delete and --purge only touch a folder this project created (it carries a marker file).
# Only install.sh creates the marker (runtime_mark). Every other entry point only CHECKS (runtime_check), so a folder that
# merely exists can never be adopted and emptied. An installation made before the marker existed is recognised by
# what only this project creates (config.local.env next to a local n8n) and marked once.
RUNTIME_MARKER=".n8n-morning-brief-runtime"
runtime_mark()  { mkdir -p "$BRIEF_HOME" && : > "$BRIEF_HOME/$RUNTIME_MARKER"; }
runtime_check() {
  [ -f "$BRIEF_HOME/$RUNTIME_MARKER" ] && return 0
  # An installation made before the marker existed is recognised ONLY by evidence that no other project has: our own
  # run script (with its signature line) next to a settings file. "Has a config file and an n8n binary" is not evidence: any
  # other n8n project looks like that, and adopting it would let rsync --delete empty its scripts/ folder.
  if [ -f "$BRIEF_HOME/config.local.env" ] && [ -f "$BRIEF_HOME/scripts/run-brief.sh" ] && grep -q "Delivers the morning brief" "$BRIEF_HOME/scripts/run-brief.sh" 2>/dev/null; then runtime_mark; return 0; fi
  echo "Refusing to modify $BRIEF_HOME: it is not a folder created by this project (missing $RUNTIME_MARKER). Run install.sh first." >&2
  return 1
}

# install.sh may start using a folder only when nothing in it can belong to someone else: it does not exist, it is empty
# (or holds only what we write first), or it passes runtime_check. Nothing is created inside a folder that is refused, and
# the marker is written only after this has passed, so a refused or failed attempt never authorises a later deletion.
runtime_claimable() {
  [ -e "$BRIEF_HOME" ] || return 0
  [ -d "$BRIEF_HOME" ] || return 1
  local e other=0
  for e in "$BRIEF_HOME"/* "$BRIEF_HOME"/.[!.]* ; do
    [ -e "$e" ] || continue
    case "$(basename "$e")" in config.local.env|logs|"$RUNTIME_MARKER") ;; *) other=1 ;; esac
  done
  [ "$other" = 0 ] && return 0
  runtime_check >/dev/null 2>&1
}

# Merge AI settings field by field: a value passed explicitly wins, everything else keeps what is saved; defaults are
# used only when nothing is saved yet. Arguments: base_url model api_key (empty = not specified).
ai_merge() {
  local base="$1" model="$2" key="$3"
  [ -n "$base$model$key" ] || return 0
  [ -n "$base" ] && config_set AI_BASE_URL "$base"
  [ -n "$model" ] && config_set AI_MODEL "$model"
  [ -n "$key" ] && config_set AI_API_KEY "$key"
  config_has AI_BASE_URL || config_set AI_BASE_URL "https://api.deepseek.com"
  config_has AI_MODEL    || config_set AI_MODEL "deepseek-chat"
  return 0
}

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# A random secret for the webhook (hex, 48 characters). Only the settings file and n8n's environment know it.
generate_token() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

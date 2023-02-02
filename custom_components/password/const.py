import os
from .manifest import manifest
from homeassistant.util.json import load_json
from homeassistant.helpers.storage import STORAGE_DIR

DOMAIN = manifest.domain
MAC_KEY = load_json(os.path.abspath(f'{STORAGE_DIR}/core.uuid'))['data']['uuid']
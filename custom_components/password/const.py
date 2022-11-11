import uuid
from .manifest import manifest

DOMAIN = manifest.domain
MAC_KEY = uuid.UUID(int=uuid.getnode()).hex[-12:]
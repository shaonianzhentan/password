from .manifest import manifest

DOMAIN = manifest.domain
API_URL = f'/api/{DOMAIN}'
API_NAME = f'api:{DOMAIN}'
WWW = f'/{DOMAIN}-www'

VERSION = manifest.version
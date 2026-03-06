FROM quay.io/oauth2-proxy/oauth2-proxy:v7.6.0

# Copy custom templates into the image at /templates/
COPY sign_in.html /templates/sign_in.html
COPY error.html /templates/error.html
COPY region-azur-dms-logo.svg /templates/region-azur-dms-logo.svg
COPY robots.txt /templates/robots.txt

# Templates are now baked into the image - no volume mount needed!
# Set OAUTH2_PROXY_CUSTOM_TEMPLATES_DIR=/templates in environment

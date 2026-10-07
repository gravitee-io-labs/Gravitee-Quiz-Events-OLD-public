# Gravitee Quiz Events - web (hub + event game + scoreboard), static nginx.
# Build context is the REPOSITORY ROOT:
#   docker build -f web/Dockerfile -t dobl1/quiz-web:2.0.0 .
FROM nginx:1.30-alpine

LABEL org.opencontainers.image.title="quiz-web" \
      org.opencontainers.image.description="Gravitee Quiz Events - player web app (hub, event game, scoreboard)"

# Remove the stock nginx welcome page: an app without pages must answer 404, not "Welcome to nginx!".
RUN rm -rf /usr/share/nginx/html/*

# Static content. Each tree lives in its own directory so dev can bind-mount them one by one.
COPY web/    /usr/share/nginx/html/
COPY shared/ /usr/share/nginx/shared/
COPY assets/ /usr/share/nginx/assets/

# Container plumbing and build tooling must never be served; drop editor/design leftovers
# (.psd sources are ~1 MB each, shared/tools is the design-system build kit).
RUN rm -f /usr/share/nginx/html/Dockerfile /usr/share/nginx/html/Dockerfile.dockerignore /usr/share/nginx/html/nginx.conf /usr/share/nginx/html/docker-entrypoint.sh \
 && rm -rf /usr/share/nginx/shared/tools \
 && rm -f /usr/share/nginx/shared/styleguide.html /usr/share/nginx/shared/js/styleguide.js /usr/share/nginx/shared/css/styleguide.css /usr/share/nginx/shared/README.md \
 && find /usr/share/nginx -name '.DS_Store' -delete \
 && find /usr/share/nginx/assets -type f \( -name '*.psd' -o -name '*.ai' \) -delete \
 && mkdir -p /usr/share/nginx/runtime \
 && printf '// Default runtime config (regenerated at container start from API_BASE_URL).\nwindow.QUIZ_CONFIG = { apiBase: "/api" };\n' > /usr/share/nginx/runtime/config.js \
 && echo "set \$quiz_connect_src \"'self'\";" > /etc/nginx/quiz-runtime.conf \
 && chmod -R a+rX /usr/share/nginx

COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY web/docker-entrypoint.sh /quiz-entrypoint.sh
RUN chmod 0755 /quiz-entrypoint.sh \
 && nginx -t

# Same-origin by default (gateway in compose, ingress in Kubernetes). Absolute URLs are accepted too.
ENV API_BASE_URL=/api

EXPOSE 80

# 127.0.0.1, not "localhost": nginx listens on IPv4 only and alpine resolves localhost to ::1 first.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/health || exit 1

ENTRYPOINT ["/quiz-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]

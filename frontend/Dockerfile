FROM nginx:1.29-alpine

ARG APP_RELEASE=local

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/

RUN sed -i "s|__APP_RELEASE__|${APP_RELEASE}|g" /usr/share/nginx/html/index.html \
    && chmod 644 /etc/nginx/conf.d/default.conf /usr/share/nginx/html/*

EXPOSE 80
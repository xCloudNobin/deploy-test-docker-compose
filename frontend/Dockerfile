FROM nginx:1.29-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/
RUN chmod 644 /etc/nginx/conf.d/default.conf /usr/share/nginx/html/*
EXPOSE 80

proxy_pass http://127.0.0.1:3000;
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Connection "";
proxy_connect_timeout 5s;
# EPUB agent can take 120s; admin ingestion can take longer.
proxy_read_timeout 600s;
proxy_send_timeout 600s;
proxy_buffering off;
proxy_next_upstream off;

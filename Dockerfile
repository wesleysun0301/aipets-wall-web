FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --global --add safe.directory /tmp/wall-data

WORKDIR /app
COPY . /app

ENV ROOM_PATH=/tmp/wall-data/room.json \
    WALL_DATA_REPO=git@github.com:wesleysun0301/aipets-wall.git \
    PYTHONUNBUFFERED=1

EXPOSE 8765
CMD ["python", "-u", "server.py"]

#!/bin/bash

set -o pipefail

if [ "$EUID" -ne 0 ]; then
    echo "Please run as root"
    exit 1
fi

if ! ischroot; then
	if docker info -f '{{ .DriverStatus }}' | grep -q 'io.containerd.snapshotter'; then
	    echo "Snapshotter already configured."
		exit 0
	fi

	if [ "$(containerd -v | awk '{print $3}' | sed 's/^v//' | cut -d. -f1)" -lt 2 ]; then
    	echo "containerd < v2, exiting."
    	exit 1
	fi

	echo "Stopping all docker compose projects ..."
	for dir in /opt/docker/*/; do
		[ -d "$dir" ] && (cd "$dir" && docker compose down) &
	done
	wait

	echo "Pruning docker images ..."
	docker image prune -a -f

	echo "Stopping docker.socket, docker.service, containerd.service ..."
	systemctl disable --now docker.socket
	systemctl disable --now docker.service
	systemctl disable --now containerd.service

	echo "Backup /var/lib/containerd"
	cp -a /var/lib/containerd /var/lib/containerd.orig
	rm -rf /var/lib/containerd/*
	echo "Create messier/containerd and mount to /var/lib/containerd"
	zfs create messier/containerd -o mountpoint=/var/lib/containerd
	echo "Restore /var/lib/containerd from backup"
	cp -a /var/lib/containerd.orig/* /var/lib/containerd
	echo "Cleanup backup"
	rm -rf /var/lib/containerd.orig
	rm -rf /var/lib/docker/overlay2/*
	
	echo "Strating docker.socket, docker.service, containerd.service ..."
	systemctl enable --now docker.socket
	systemctl enable --now docker.service
	systemctl enable --now containerd.service

	echo "Starting all docker compose projects ..."
	for dir in /opt/docker/*/; do
		[ -d "$dir" ] && (cd "$dir" && docker compose up -d) &
	done
	wait

	echo "Snapshotter configured."
fi

#!/bin/bash
# Sashimono test vm setup script.
# This must be executed with root privileges.

# This script performs following activities.
# 1. Install debugging tools.
# 2. Install Sashimono prerequisites and reboots.
# 3. Install Sashimono after reboot.
# 4. Reboot after installing Sashimono.

# Install debugging tools
# sqlite is used to fetch lcl from cluster script
# smem is a memory reporting tool used to analyze instance users memory usage.
apt-get -y install sqlite3 smem

cloudstorage="https://sthotpocket.blob.core.windows.net/sashimono"
bootscript="/usr/local/bin/sashimono-install.sh"
boot_service="sashimonoboot"

# Create boot script.
echo "#!/bin/bash

# Remove ourselves.
rm $bootscript
systemctl disable $boot_service
rm /etc/systemd/system/$boot_service.service
systemctl daemon-reload

# Install Sashimono and reboot.
curl -fsSL $cloudstorage/install.sh | bash -s -- -q
reboot" >$bootscript

chmod +x $bootscript

echo "[Unit]
Description=Sashimono test vm setup one-time boot script
ConditionPathExists=$bootscript
[Service]
ExecStart=$bootscript -q
[Install]
WantedBy=multi-user.target" >/etc/systemd/system/$boot_service.service
# Schedule the boot script to run at startup.
systemctl enable $boot_service

# Install Sashimono prerequisites and reboot.
curl -fsSL $cloudstorage/prereq.sh | bash -s -- -q
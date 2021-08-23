#!/bin/bash
# Sashimono test vm setup script.
# This must be executed with root privileges.

# This script performs following activities.
# 1. Install Sashimono prerequisites and reboots.
# 2. Install Sashimono after reboot.
# 3. Restarts cgroup engine service after installing Sashimono.

cloudstorage="https://sthotpocket.blob.core.windows.net/sashimono"
bootscript="/usr/local/bin/sashimono-install.sh"
cgrulesengd_service="cgrulesengdsvc"
boot_service="sashimonoboot"

# Create boot script.
echo "#!/bin/bash

# Install Sashimono and restart cgrules service.
curl -fsSL $cloudstorage/install.sh | bash
echo Restarting $cgrulesengd_service
systemctl restart $cgrulesengd_service

# Remove ourselves.
rm $bootscript
systemctl disable $boot_service
rm /etc/systemd/system/$boot_service.service
systemctl daemon-reload" >$bootscript
chmod +x $bootscript

echo "[Unit]
Description=Sashimono test vm setup one-time boot script
ConditionPathExists=$bootscript
[Service]
ExecStart=$bootscript
[Install]
WantedBy=multi-user.target" >/etc/systemd/system/$boot_service.service
# Schedule the boot script to run at startup.
systemctl enable $boot_service

# Install Sashimono prerequisites and reboot.
curl -fsSL $cloudstorage/prereq.sh | bash -s -- -q

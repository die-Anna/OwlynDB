# SSH-Testserver für den SSH-Tunnel (nur lokal, Wegwerf-Zugang)
FROM alpine:3.22
RUN apk add --no-cache openssh-server \
 && ssh-keygen -A \
 && adduser -D -s /bin/sh tunnel \
 && echo 'tunnel:tunnel-test' | chpasswd \
 && printf 'AllowTcpForwarding yes\nPasswordAuthentication yes\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/test.conf
# Schlüssel aus dev/certs (make-certs.sh); sshd verlangt strenge Rechte, die Windows-Freigabe liefert sie nicht
CMD ["sh", "-c", "mkdir -p /home/tunnel/.ssh && cat /certs/ssh_client.pub /certs/ssh_client_enc.pub > /home/tunnel/.ssh/authorized_keys && chown -R tunnel /home/tunnel/.ssh && chmod 700 /home/tunnel/.ssh && chmod 600 /home/tunnel/.ssh/authorized_keys && exec /usr/sbin/sshd -D -e"]

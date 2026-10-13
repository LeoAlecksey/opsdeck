<!--
База знаний локального ИИ: шпаргалки по инструментам DevOps. Строки идут в подсказку модели,
когда запрос похож на тему, поэтому формат простой и строгий:

  # <инструмент>
  алиасы: <слова, по которым узнаём тему, через запятую>
  - <команда> — <что делает>

Команды — с заглушками в угловых скобках (<ns>, <pod>), без реальных хостов, адресов и паролей.
Опасные вещи (удаление, перезапись) либо не пишем, либо только с ключом подтверждения.
-->

# kubectl
алиасы: k8s, kubernetes, кубер, куб, под, pod, поды, неймспейс, namespace, деплой, deployment, кластер, кубектл
- kubectl -n <ns> get pods -o wide — поды неймспейса с узлами и адресами
- kubectl -n <ns> get pods --sort-by=.status.containerStatuses[0].restartCount — поды по числу перезапусков
- kubectl -n <ns> describe pod <pod> — события и причины: образ, ресурсы, тома
- kubectl -n <ns> logs <pod> -c <container> --tail=200 -f — логи контейнера, следить
- kubectl -n <ns> logs <pod> --previous — логи упавшего контейнера до перезапуска
- kubectl -n <ns> exec -it <pod> -- sh -c 'ps -o pid,comm' — команда внутри пода
- kubectl -n <ns> rollout restart deploy/<name> — перезапуск деплоя
- kubectl -n <ns> rollout status deploy/<name> --timeout=120s — дождаться раскатки
- kubectl -n <ns> rollout undo deploy/<name> — откатить на прошлую версию
- kubectl -n <ns> get events --sort-by=.lastTimestamp | tail -30 — последние события
- kubectl -n <ns> port-forward svc/<svc> 8080:80 — порт сервиса к себе
- kubectl top pod -n <ns> --containers — потребление CPU и памяти
- kubectl get nodes -o wide — узлы, версии kubelet, адреса
- kubectl -n <ns> get pvc,pv — тома и их статус
- kubectl -n <ns> get secret <name> -o jsonpath='{.data.<key>}' | base64 -d — значение секрета
- kubectl -n <ns> scale deploy/<name> --replicas=3 — число реплик
- kubectl -n <ns> get deploy <name> -o yaml | kubectl neat — манифест без служебных полей
- kubectl auth can-i --list -n <ns> — что разрешено текущему контексту
- kubectl config get-contexts — контексты kubeconfig

# helm
алиасы: хелм, чарт, chart, релиз, release, values
- helm -n <ns> list -a — релизы неймспейса, включая неудачные
- helm -n <ns> history <release> — версии релиза
- helm -n <ns> get values <release> -a — значения, с которыми раскатан релиз
- helm -n <ns> upgrade --install <release> <chart> -f values.yaml --atomic --timeout 5m — раскатка с откатом при ошибке
- helm -n <ns> rollback <release> <revision> — откат на версию
- helm -n <ns> diff upgrade <release> <chart> -f values.yaml — что изменится (плагин helm-diff)
- helm template <release> <chart> -f values.yaml | kubectl apply --dry-run=server -f - — проверить манифесты
- helm -n <ns> uninstall <release> — удалить релиз (спросить подтверждение)

# docker
алиасы: докер, контейнер, container, образ, image, compose, компоуз
- docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' — контейнеры и их состояние
- docker logs -f --tail 200 <name> — логи контейнера
- docker exec -it <name> sh — оболочка внутри контейнера
- docker stats --no-stream — CPU, память, сеть по контейнерам
- docker inspect -f '{{json .State.Health}}' <name> — состояние health-check
- docker image ls --format '{{.Repository}}:{{.Tag}} {{.Size}}' — образы с размером
- docker system df — чем занято место
- docker compose up -d --build — поднять стек из compose-файла
- docker compose logs -f --tail 200 <service> — логи сервиса стека
- docker compose ps — состояние сервисов стека

# systemd
алиасы: systemctl, journalctl, сервис, служба, service, демон, юнит, unit, автозапуск
- systemctl status <unit> --no-pager -l — состояние службы и последние строки лога
- systemctl restart <unit> — перезапуск
- systemctl enable --now <unit> — включить и запустить
- systemctl list-units --failed — что упало
- systemctl list-timers --all — таймеры и когда сработают
- systemctl cat <unit> — юнит целиком, с переопределениями
- systemctl show <unit> -p FragmentPath,Restart,ExecStart — отдельные параметры
- journalctl -u <unit> -n 200 --no-pager — последние строки лога службы
- journalctl -u <unit> -f — следить за логом
- journalctl -u <unit> --since '1 hour ago' -p err — только ошибки за час
- journalctl -b -1 -p err --no-pager — ошибки предыдущей загрузки

# terraform
алиасы: терраформ, tofu, опентофу, план, plan, state, стейт, инфраструктура как код
- terraform init -upgrade — модули и провайдеры
- terraform plan -out tf.plan — план в файл, чтобы применить ровно его
- terraform apply tf.plan — применить сохранённый план
- terraform plan -target=module.<name> — план только по части конфигурации
- terraform fmt -recursive — форматирование
- terraform validate — проверка синтаксиса и типов
- terraform state list — объекты в состоянии
- terraform state show <addr> — один объект из состояния
- terraform output -json — выходные значения машинно
- terraform workspace list — окружения состояния

# git
алиасы: гит, коммит, commit, ветка, branch, мерж, merge, rebase, ребейз, диff, diff
- git status -sb — короткий статус с веткой и отставанием
- git log --oneline --graph --decorate -20 — последние коммиты графом
- git log --oneline @{u}.. — что ещё не отправлено в удалённую ветку
- git diff --stat @{u} — чем отличается от удалённой ветки
- git switch -c <branch> — новая ветка от текущей
- git fetch --prune && git pull --ff-only — обновить без лишних мержей
- git push -u origin HEAD — отправить текущую ветку
- git stash push -m '<текст>' — отложить правки
- git restore --source=HEAD --staged --worktree <file> — вернуть файл как в HEAD
- git blame -L <from>,<to> <file> — кто менял строки
- git bisect start <bad> <good> — поиск коммита, который сломал

# ssh
алиасы: ssh, scp, sftp, туннель, tunnel, ключ, key, jump, бастион, bastion
- ssh -J <bastion> <user>@<host> — вход через бастион
- ssh -L 8080:127.0.0.1:80 <host> — локальный порт в сторону хоста
- ssh -R 9000:127.0.0.1:9000 <host> — порт хоста в сторону себя
- ssh -o BatchMode=yes <host> 'uptime' — одна команда без интерактива
- ssh-copy-id -i ~/.ssh/<key>.pub <host> — положить ключ на хост
- ssh -G <host> — какие настройки применит ssh для хоста
- scp -3 <host1>:<path> <host2>:<path> — копирование между хостами через себя
- sftp -b - <host> — пакетный режим: get, put, ls, mkdir из stdin
- ssh-keygen -t ed25519 -C '<комментарий>' — новый ключ

# jq и yq
алиасы: jq, yq, json, yaml, фильтр, парсить
- jq -r '.items[] | .metadata.name' — имена из массива
- jq -r 'to_entries[] | "\(.key)=\(.value)"' — объект в key=value
- jq -s 'add' a.json b.json — объединить файлы
- jq --arg n <name> '.items[] | select(.metadata.name==$n)' — выбрать по значению
- yq '.spec.template.spec.containers[].image' values.yaml — поле из YAML
- yq -i '.image.tag = "<tag>"' values.yaml — правка YAML на месте

# текстовые фильтры
алиасы: awk, sed, grep, sort, uniq, wc, tail, head, вырезать, посчитать
- grep -rn --include='*.yaml' '<текст>' . — поиск по файлам с номерами строк
- grep -c '<текст>' <file> — сколько строк совпало
- awk '{print $1, $7}' <file> — выбрать столбцы
- awk '$9 >= 500 {n++} END {print n+0}' access.log — посчитать по условию
- sort | uniq -c | sort -rn | head -20 — топ повторов
- sed -n '100,120p' <file> — строки диапазоном
- tail -f <file> | grep --line-buffered '<текст>' — следить с фильтром
- cut -d: -f1 /etc/passwd — поле по разделителю

# диски и файлы
алиасы: df, du, lsblk, место, диск, inode, найти файл, find, tar, архив
- df -h — свободное место по точкам монтирования
- df -i — свободные inode (место есть, а файлы не создаются)
- du -xh --max-depth=1 <dir> | sort -h — что занимает место в папке
- lsblk -f — диски, разделы, файловые системы
- find <dir> -type f -size +100M -printf '%s %p\n' | sort -rn | head — крупные файлы
- find <dir> -type f -mtime -1 — изменённые за сутки
- tar -czf <archive>.tar.gz -C <dir> . — архив папки
- tar -tzf <archive>.tar.gz | head — что внутри архива
- lsof +D <dir> — кто держит файлы в папке

# сеть и dns
алиасы: сеть, network, порт, port, ss, netstat, dig, dns, ping, mtr, traceroute, curl, iptables, nft
- ss -tulpn — кто какие порты слушает и чем
- ss -tn state established '( dport = :443 )' — установленные соединения на 443
- dig +short <name> A — адрес по имени
- dig <name> @<server> +trace — где именно ломается разрешение имени
- dig -x <ip> +short — обратная запись
- curl -sS -o /dev/null -w '%{http_code} %{time_total}\n' <url> — код и время ответа
- curl -sS -H 'Authorization: Bearer <token>' <url> — запрос с заголовком
- mtr -rwzbc 50 <host> — потери и задержки по пути
- ip -br a — адреса интерфейсов коротко
- ip r get <ip> — через какой маршрут пойдёт пакет
- nft list ruleset — правила файрвола (nftables)
- iptables -L -n -v --line-numbers — правила файрвола (iptables)

# процессы и нагрузка
алиасы: процесс, process, нагрузка, load, память, memory, cpu, oom, top, ps
- ps -eo pid,ppid,rss,pcpu,etime,cmd --sort=-rss | head -20 — топ по памяти
- ps -eo pid,pcpu,cmd --sort=-pcpu | head -20 — топ по CPU
- uptime — load average за 1, 5 и 15 минут
- free -h — память и swap
- vmstat 1 5 — очередь, подкачка, ввод-вывод по секундам
- iostat -xz 1 3 — нагрузка на диски по устройствам
- dmesg -T | grep -i -e oom -e 'killed process' — кого убил OOM
- pidstat -p <pid> 1 5 — один процесс по секундам

# nginx
алиасы: nginx, веб-сервер, ingress, прокси, proxy, 502, 504
- nginx -t — проверить конфигурацию
- nginx -T | grep -n 'server_name\|proxy_pass' — конфигурация целиком с подключёнными файлами
- systemctl reload nginx — применить конфигурацию без обрыва соединений
- tail -f /var/log/nginx/error.log — ошибки, следить
- awk '{print $9}' /var/log/nginx/access.log | sort | uniq -c | sort -rn — коды ответов
- awk '$9 ~ /^5/ {print $7}' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head — пути с 5xx

# postgresql
алиасы: postgres, postgresql, psql, база, бд, sql, запрос, блокировка, вакуум
- psql -h <host> -U <user> -d <db> -c '\l+' — базы с размером
- psql -c "select pid, now()-query_start as age, state, left(query,80) from pg_stat_activity where state<>'idle' order by age desc limit 20" — активные запросы
- psql -c "select * from pg_locks l join pg_stat_activity a using (pid) where not granted" — кто кого блокирует
- psql -c "select relname, pg_size_pretty(pg_total_relation_size(relid)) from pg_statio_user_tables order by pg_total_relation_size(relid) desc limit 20" — крупные таблицы
- psql -c 'select * from pg_stat_replication' — состояние репликации
- pg_dump -h <host> -U <user> -Fc -f <file>.dump <db> — дамп базы
- psql -c "explain (analyze, buffers) <запрос>" — план запроса с фактами

# mysql
алиасы: mysql, mariadb, mysqldump, innodb
- mysql -h <host> -u <user> -p -e 'show processlist' — активные соединения
- mysql -e 'show engine innodb status\G' | sed -n '1,60p' — состояние InnoDB
- mysql -e "select table_schema, round(sum(data_length+index_length)/1024/1024) mb from information_schema.tables group by 1 order by mb desc" — размер баз
- mysql -e 'show replica status\G' — состояние репликации
- mysqldump -h <host> -u <user> -p --single-transaction <db> > <file>.sql — дамп без блокировок

# ansible
алиасы: ansible, плейбук, playbook, инвентарь, inventory, роль
- ansible -i <inventory> <group> -m ping — доступность хостов
- ansible-playbook -i <inventory> <playbook>.yml --check --diff — прогон без изменений
- ansible-playbook -i <inventory> <playbook>.yml -l <host> -t <tag> — часть по хосту и тегу
- ansible-inventory -i <inventory> --graph — группы и хосты
- ansible-vault edit <file>.yml — правка зашифрованного файла

# yandex cloud
алиасы: yc, yandex, яндекс облако, облако, вм, instance, фолдер, каталог
- yc config profile list — профили CLI, активный помечен
- yc --format json compute instance list --folder-id <folder> — машины каталога
- yc compute instance stop --id <id> — выключить машину
- yc compute instance start --id <id> — включить машину
- yc --format json vpc subnet list --folder-id <folder> — подсети
- yc --format json vpc security-group list --folder-id <folder> — группы безопасности с правилами
- yc managed-kubernetes cluster get-credentials <cluster> --external — kubeconfig кластера
- yc --format json billing account list — платёжные аккаунты и баланс

# сертификаты
алиасы: openssl, сертификат, certificate, tls, ssl, срок действия, цепочка
- openssl s_client -connect <host>:443 -servername <host> </dev/null 2>/dev/null | openssl x509 -noout -dates -subject -issuer — срок и кем выдан
- openssl x509 -in <file>.crt -noout -text | head -20 — что внутри сертификата
- openssl x509 -in <file>.crt -noout -enddate — до какого числа действует
- openssl req -new -newkey rsa:2048 -nodes -keyout <name>.key -out <name>.csr -subj '/CN=<host>' — ключ и запрос
- openssl verify -untrusted <chain>.pem <cert>.pem — проверить цепочку

# Локальный ИИ и OpenCode

[← Wiki](README.md)

OpsDeck AI и OpenCode настраиваются отдельно. **OpsDeck AI** использует модель из **⚙ → Локальный ИИ**. **OpenCode** запускается как программа `opencode` в AI-панели и читает собственный `opencode.json`. Сервер, указанный в OpsDeck, автоматически в OpenCode не передаётся.

## Встроенная модель OpsDeck

1. Откройте **⚙ → Локальный ИИ**, выберите модель и нажмите **Установить**. Движок llama.cpp и модель загрузятся с проверкой контрольной суммы. Можно выбрать собственный `.gguf`.
2. Откройте AI-панель через `Ctrl+Shift+I`, выберите **OpsDeck AI (локальный)** и задайте вопрос. `Ctrl+Shift+K` в терминале генерирует команду по описанию; **Вставить** добавляет её без запуска.
3. При необходимости измените контекст (по умолчанию 16 384 токена) и ускорение: Vulkan на Linux/Windows, Metal на macOS.

Модель запускается при первом запросе и выгружается через 15 минут простоя. Встроенный сервер слушает случайный порт `127.0.0.1` и предназначен для OpsDeck, поэтому для OpenCode используйте отдельно запущенный Ollama, LM Studio, vLLM или другой сервер.

## Внешний локальный сервер для OpsDeck AI

В **⚙ → Локальный ИИ → Внешний ИИ-сервер** укажите **Адрес**, **Порт**, **Модель** и при необходимости **API-ключ**. Для Ollama на том же компьютере: адрес `127.0.0.1`, порт `11434`, модель — точное имя из `ollama list`. Нажмите **Проверить** и сохраните. OpsDeck добавляет пути `/v1` API сам. После этого **OpsDeck AI** использует внешний сервер вместо встроенного движка.

## OpenCode с Ollama через JSON

1. Установите OpenCode и Ollama отдельно. Проверьте `opencode --version`, загрузите модель командой `ollama pull gemma3:4b` и проверьте имя через `ollama list`.
2. Создайте `~/.config/opencode/opencode.json` для всех проектов или `opencode.json` в конкретном проекте. Для Ollama на стандартном порту:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "model": "ollama/gemma3:4b"
   }
   ```

3. В OpsDeck откройте **⚙ → AI-агент** и выберите **OpenCode**, либо выберите его в AI-панели `Ctrl+Shift+I`. После изменения JSON перезапустите OpenCode. Команда `/models` покажет доступные модели.

Для другого адреса или порта Ollama используйте:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "ollama/gemma3:4b",
  "providers": {
    "ollama": {
      "settings": {
        "baseURL": "http://127.0.0.1:5678/v1"
      }
    }
  }
}
```

OpenCode обнаруживает модели Ollama через нативный API того же сервера. Если нужен bearer-токен, добавьте в `settings` поле `"apiKey": "{env:OLLAMA_API_KEY}"` и задайте переменную окружения для процесса OpenCode.

## OpenCode с другим OpenAI-совместимым сервером

Для LM Studio на стандартном локальном порту OpenCode умеет находить модели автоматически. Для произвольного сервера задайте провайдер и точный ID модели из `/v1/models`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "local/coder",
  "providers": {
    "local": {
      "name": "Local server",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:1234/v1"
      },
      "models": {
        "coder": {
          "modelID": "model-name-on-server",
          "capabilities": {
            "tools": true,
            "input": ["text"],
            "output": ["text"]
          },
          "limit": {
            "context": 32768,
            "output": 8192
          }
        }
      }
    }
  }
}
```

Замените адрес, `modelID` и лимиты на данные своего сервера. Для редактирования файлов модель и сервер должны поддерживать вызовы инструментов. Если нужен ключ, добавьте `"apiKey": "{env:LOCAL_API_KEY}"` в `settings`; секрет не храните в проектном JSON.

## Если не работает

- OpenCode не запускается: проверьте `opencode --version` в терминале OpsDeck и `PATH`.
- Модели нет в `/models`: проверьте доступность сервера, URL `/v1` и ID модели.
- Модель отвечает, но не правит файлы: проверьте поддержку tool calling и `capabilities.tools`.
- OpsDeck AI работает, а OpenCode нет: проверьте `opencode.json`; это разные настройки.

Подробности по текущему формату: [конфигурация OpenCode](https://opencode.ai/docs/config/) и [локальные модели OpenCode](https://opencode.ai/docs/models/).

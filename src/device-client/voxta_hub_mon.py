#!/usr/bin/env python3
import logging
import time
import requests
from signalrcore.hub_connection_builder import HubConnectionBuilder
from signalrcore.protocol.json_hub_protocol import JsonHubProtocol

logging.basicConfig(level=logging.INFO)

def get_last_chat_id():
    try:
        resp = requests.get("http://localhost:5384/api/chats")
        resp.raise_for_status()
        data = resp.json()
        chats = data.get("chats", [])
        return chats[0]["id"] if chats else None
    except Exception as e:
        logging.error(f"Failed to get last chat ID: {e}")
        return None

def main():
    session_id = None

    hub_connection = (
        HubConnectionBuilder()
        .with_url("ws://localhost:5384/hub", options={
            "skip_negotiation": True,
            "transport": "websockets"
        })
        .configure_logging(logging.INFO)
        .with_automatic_reconnect({
            "type": "interval",
            "keep_alive_interval": 10,
            "intervals": [1, 3, 5, 6, 7, 87, 3]
        })
        .with_hub_protocol(JsonHubProtocol())
        .build()
    )

    def on_open():
        logging.info("[🚀] Connected to Voxta hub")
        try:
            # Authenticate
            auth_message = {
                "$type": "authenticate",
                "client": "SimpleClient",
                "clientVersion": "1.0.0",
                "scope": ["role:app"]
            }
            hub_connection.send("SendMessage", auth_message)
            logging.info("[✓] Sent authentication")

            # Resume chat
            chat_id = get_last_chat_id()
            if chat_id:
                logging.info(f"[🔄] Resuming chat: {chat_id}")
                resume_message = {
                    "$type": "resumeChat",
                    "chatId": chat_id
                }
                hub_connection.send("SendMessage", resume_message)
            else:
                logging.info("[!] No existing chat found")
        except Exception as e:
            logging.error(f"[❌] Error in on_open: {e}")

    def on_message(message):
        nonlocal session_id
        try:
            if isinstance(message, dict):
                msg_type = message.get("$type", "unknown")
                
                if msg_type == "chatStarting":
                    session_id = message.get("sessionId")
                    logging.info(f"[✓] Chat starting with sessionId: {session_id}")
                elif msg_type == "error":
                    logging.error(f"[❌] Received error: {message.get('message', 'Unknown error')}")
                    return
                
                if (message.get("sessionId") and 
                    session_id and 
                    message.get("sessionId") != session_id and 
                    msg_type != "chatStarting"):
                    logging.warning(
                        f"[!] Session mismatch: current={session_id} incoming={message.get('sessionId')}"
                    )
                    return

                logging.info(f"[←] {msg_type}")
                if logging.getLogger().isEnabledFor(logging.DEBUG):
                    logging.debug(f"Full message: {message}")
        except Exception as e:
            logging.error(f"[❌] Error processing message: {e}")

    def on_error(error):
        try:
            if hasattr(error, 'error'):
                logging.error(f"[❌] Connection error: {error.error}")
            else:
                logging.error(f"[❌] Connection error: {error}")
        except Exception as e:
            logging.error(f"[❌] Error in error handler: {e}")

    def on_close():
        logging.info("[←] Connection closed")

    # Attach handlers
    hub_connection.on_open(on_open)
    hub_connection.on_close(on_close)
    hub_connection.on_error(on_error)
    hub_connection.on("ReceiveMessage", on_message)

    # Start connection with error handling
    try:
        hub_connection.start()
        
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        logging.info("[→] Shutting down...")
    except Exception as e:
        logging.error(f"[❌] Fatal error: {e}")
    finally:
        try:
            hub_connection.stop()
            logging.info("[✓] Disconnected cleanly")
        except Exception as e:
            logging.error(f"[❌] Error during shutdown: {e}")

if __name__ == "__main__":
    main()

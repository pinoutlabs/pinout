#include <Arduino.h>
#include <ArduinoJson.h>

// Bounded SRAM use on the ATmega328P. Larger/unsupported frames fail closed.
char line[256];
uint16_t used = 0;
bool overflow = false;
StaticJsonDocument<384> request;
bool active[20] = {};
uint8_t safe[20] = {}; // low, high, high-z
bool armed = false;
bool tripped = false;
unsigned long deadline = 0;
unsigned long timeoutMs = 1000;

void stopOutputs() {
  for (uint8_t p=2; p<20; ++p) if (active[p]) {
    if (safe[p] == 2) pinMode(p, INPUT);
    else { digitalWrite(p, safe[p] == 1 ? HIGH : LOW); pinMode(p, OUTPUT); }
    active[p] = false;
  }
}
void pollWatchdog() {
  if (armed && (long)(millis()-deadline)>=0) {
    stopOutputs(); armed=false; tripped=true;
    Serial.println(F("{\"v\":1,\"event\":\"device.tripped\",\"payload\":{\"reason\":\"WATCHDOG_EXPIRED\"}}"));
  }
}
void prefix(const char* id, bool ok) {
  Serial.print(F("{\"v\":1,\"id\":"));
  serializeJson(request["id"], Serial);
  Serial.print(ok ? F(",\"ok\":true,\"result\":") : F(",\"ok\":false,\"error\":"));
}
void error(const char* id, const __FlashStringHelper* code) {
  prefix(id,false); Serial.print(F("{\"code\":\"")); Serial.print(code);
  Serial.println(F("\",\"message\":\"Request refused by Uno bridge.\"}}"));
}
void state(const char* id) {
  prefix(id,true); Serial.print(F("{\"armed\":")); Serial.print(armed ? F("true") : F("false"));
  Serial.print(F(",\"state\":\"")); Serial.print(armed ? F("armed") : tripped ? F("tripped") : F("disarmed"));
  Serial.print(F("\",\"timeoutMs\":")); Serial.print(timeoutMs); Serial.println(F("}}"));
}
void hello(const char* id) {
  prefix(id,true);
  Serial.println(F("{\"firmware\":\"uno-bridge\",\"boardId\":\"arduino-uno\",\"version\":\"0.0.1-alpha.1\",\"protocol\":1,\"features\":[\"watchdog\",\"arming\",\"safe-state\"],\"capabilities\":[\"sys.hello\",\"sys.ping\",\"sys.info\",\"sys.arm\",\"sys.disarm\",\"watchdog.kick\",\"gpio.configSafeState\",\"gpio.mode\",\"gpio.write\",\"gpio.read\",\"gpio.analogRead\",\"gpio.stopAll\"]}}"));
}
void handle() {
  if (deserializeJson(request, line)) return;
  const char* id=request["id"] | "";
  const char* action=request["action"] | "";
  JsonObject p=request["payload"].as<JsonObject>();
  if (!*id || strlen(id)>48 || request["v"] != 1 || p.isNull()) { error(id,F("INVALID_PAYLOAD")); return; }
  if (!strcmp(action,"sys.hello")) { hello(id); return; }
  if (!strcmp(action,"sys.ping")) { prefix(id,true); Serial.println(F("{\"pong\":true}}")); return; }
  if (!strcmp(action,"sys.info")) { prefix(id,true); Serial.print(F("{\"uptimeMs\":")); Serial.print(millis()); Serial.println(F("}}")); return; }
  if (!strcmp(action,"sys.arm")) {
    if (p.containsKey("timeoutMs") && (!p["timeoutMs"].is<unsigned long>() || p["timeoutMs"].as<unsigned long>()<250 || p["timeoutMs"].as<unsigned long>()>10000)) { error(id,F("INVALID_PAYLOAD")); return; }
    timeoutMs=p["timeoutMs"] | 1000UL; armed=true; tripped=false; deadline=millis()+timeoutMs; state(id); return;
  }
  if (!strcmp(action,"sys.disarm")) { stopOutputs(); armed=false; tripped=false; state(id); return; }
  if (!strcmp(action,"gpio.stopAll")) { stopOutputs(); armed=false; prefix(id,true); Serial.println(F("{\"stoppedPins\":[]}}")); return; }
  if (!strcmp(action,"watchdog.kick")) {
    if (!armed) { error(id, tripped ? F("WATCHDOG_TRIPPED") : F("NOT_ARMED")); return; }
    if (p.containsKey("validityMs")) { error(id,F("INVALID_PAYLOAD")); return; }
    deadline=millis()+timeoutMs; prefix(id,true); Serial.print(F("{\"kicked\":true,\"timeoutMs\":")); Serial.print(timeoutMs); Serial.println(F("}}")); return;
  }
  bool config=!strcmp(action,"gpio.configSafeState");
  bool mode=!strcmp(action,"gpio.mode");
  bool write=!strcmp(action,"gpio.write");
  bool read=!strcmp(action,"gpio.read");
  bool adc=!strcmp(action,"gpio.analogRead");
  if (!config && !mode && !write && !read && !adc) { error(id,F("UNSUPPORTED_CAPABILITY")); return; }
  if (!p["pin"].is<int>() || p["pin"].as<int>()<2 || p["pin"].as<int>()>19) { error(id,F("INVALID_PIN")); return; }
  uint8_t pin=p["pin"];
  if (config) {
    const char* level=p["safeLevel"] | "low";
    const char* polarity=p["polarity"] | "active-high";
    if (strcmp(polarity,"active-high") && strcmp(polarity,"active-low")) { error(id,F("INVALID_PAYLOAD")); return; }
    if (strcmp(level,"low") && strcmp(level,"high") && strcmp(level,"high-z")) { error(id,F("INVALID_PAYLOAD")); return; }
    if (armed) { error(id,F("ALREADY_ARMED")); return; }
    safe[pin]=!strcmp(level,"high") ? 1 : !strcmp(level,"high-z") ? 2 : 0;
    prefix(id,true); Serial.print(F("{\"pin\":")); Serial.print(pin); Serial.print(F(",\"safeLevel\":")); Serial.write('"'); Serial.print(level); Serial.write('"'); Serial.print(F(",\"polarity\":\"")); Serial.print(polarity); Serial.println(F("\"}}")); return;
  }
  if ((mode || write) && !armed) { error(id,tripped ? F("WATCHDOG_TRIPPED") : F("NOT_ARMED")); return; }
  if (write) {
    if (!p["value"].is<bool>() || p.containsKey("validityMs")) { error(id,F("INVALID_PAYLOAD")); return; }
    digitalWrite(pin,p["value"].as<bool>() ? HIGH : LOW); pinMode(pin,OUTPUT); active[pin]=true;
  }
  if (mode) {
    const char* m=p["mode"] | "";
    if (p.containsKey("safeLevel") || p.containsKey("polarity")) { error(id,F("INVALID_PAYLOAD")); return; }
    if (!strcmp(m,"output")) { digitalWrite(pin,safe[pin]==1 ? HIGH : LOW); pinMode(pin,OUTPUT); active[pin]=true; }
    else if (!strcmp(m,"input")) { pinMode(pin,INPUT); active[pin]=false; }
    else if (!strcmp(m,"pullup")) { pinMode(pin,INPUT_PULLUP); active[pin]=true; }
    else { error(id,F("INVALID_PAYLOAD")); return; }
    prefix(id,true); Serial.print(F("{\"pin\":")); Serial.print(pin); Serial.print(F(",\"mode\":")); Serial.write('"'); Serial.print(m); Serial.write('"'); Serial.println(F("}}")); return;
  }
  if (adc && pin<14) { error(id,F("INVALID_PIN")); return; }
  prefix(id,true); Serial.print(F("{\"pin\":")); Serial.print(pin); Serial.print(F(",\"value\":"));
  if (adc) Serial.print(analogRead(pin)); else Serial.print(digitalRead(pin) ? F("true") : F("false"));
  Serial.println(F("}}"));
}
void setup() { Serial.begin(115200); }
void loop() {
  pollWatchdog();
  // Service expiry between bytes even under a continuous malformed input flood.
  while (Serial.available()) {
    pollWatchdog(); char c=Serial.read();
    if (c=='\n') { if (!overflow) { line[used]=0; handle(); } used=0; overflow=false; }
    else if (c!='\r' && !overflow) { if (used<sizeof(line)-1) line[used++]=c; else overflow=true; }
  }
}

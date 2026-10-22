#include "../../firmware/uno-bridge/src/main.cpp"
int main() {
  setup();
  std::string input;
  while (std::getline(std::cin,input)) {
    if (input.rfind("@advance ",0)==0) { clockMs+=std::stoul(input.substr(9)); loop(); }
    else { Serial.input=input+"\n"; loop(); }
  }
}

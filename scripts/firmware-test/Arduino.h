#pragma once
#include <cstdint>
#include <cstring>
#include <string>
#include <sstream>
#include <iostream>
using __FlashStringHelper = char;
#define F(x) x
#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2
inline unsigned long clockMs=0;
inline int levels[20]={};
inline int modes[20]={};
inline unsigned long millis(){return clockMs;}
inline void pinMode(int p,int m){modes[p]=m;}
inline void digitalWrite(int p,int v){levels[p]=v;}
inline int digitalRead(int p){return levels[p];}
inline int analogRead(int){return 512;}
struct SerialMock {
  std::string input;
  void begin(int){}
  int available(){return input.size();}
  int read(){char c=input[0];input.erase(0,1);return c;}
  size_t write(uint8_t c){std::cout<<char(c);return 1;}
  size_t write(const uint8_t* p,size_t n){std::cout.write(reinterpret_cast<const char*>(p),n);return n;}
  template<class T> void print(T v){std::cout<<v;}
  void print(uint8_t v){std::cout<<unsigned(v);}
  template<class T> void println(T v){print(v);std::cout<<'\n';}
};
inline SerialMock Serial;

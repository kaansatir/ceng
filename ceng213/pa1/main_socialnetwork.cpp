#include <iostream>

#include "SocialNetwork.h"

int main() {
    SocialNetwork snetwork;

    snetwork.print();

    std::cout << '\n';

    snetwork.addProfile("varli","yigit", "em1");
    snetwork.addProfile("varli","yigithan", "em2");//gökcan demiralpin fikri "<" operatörünü test ediyor
    snetwork.addProfile("yeni","kisi", "em3");
    
    snetwork.print();

    std::cout << '\n';

    snetwork.addPost("post1","em1 ");
    snetwork.addPost("post2","em2");
    snetwork.addPost("post3","em1");
    snetwork.addPost("post4","em2");
    snetwork.addPost("post5","em1");//söke fikri
    snetwork.addPost("post6","em2");

    snetwork.likePost(5, "em2");//kendine like attı
    snetwork.likePost(1, "em2");//kendine like attı
    snetwork.likePost(2, "em2");//kendine like attı

	snetwork.makeFriends("em1", "em2");
	snetwork.makeFriends("em3", "em2");
	snetwork.makeFriends("em1", "em3");
    
    snetwork.print();

    std::cout << '\n';
    snetwork.getMutualFriends("em1","em2");
   // std::cout<<"İlk Ortak Arkadaş : " << snetwork.getMutualFriends("em1","em2").getFirstNode()->data->getEmail()<<std::endl;
	
	snetwork.print();

    std::cout << '\n';

    return 0;
}
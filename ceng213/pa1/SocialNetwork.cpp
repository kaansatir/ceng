#include "SocialNetwork.h"

#include <iostream>
#define dbg(x) std::cout<<#x<<": "<<x<<std::endl; 
SocialNetwork::SocialNetwork() {

}

void SocialNetwork::addProfile(const std::string &firstname, const std::string &lastname, const std::string &email) {
    Profile profil = Profile(firstname, lastname, email);
    this->profiles.insertSorted(profil);
    /* TODO */
}

void SocialNetwork::addPost(const std::string &message, const std::string &email) {
    Post tmp = Post(message);
    this->posts.insertAtTheTail(tmp);
    Node<Profile> *curr = this->profiles.getFirstNode();
    while(curr)
    {
        if(curr->data.getEmail() == email)
        {
            curr->data.addPost(&((posts.getLastNode())->data));
            break;
        }
        curr = curr->next;
    }
    return;
}
void SocialNetwork::deleteProfile(const std::string &email) {
    Node<Profile> *curr = this->profiles.getFirstNode();
    Node<Profile> *profile1 = NULL;
    while(curr)
    {
        if(curr->data.getEmail() == email)
        {
            profile1 = curr;
            break;
        }
        curr = curr->next;
    }

    Node<Profile>* profil = profiles.getFirstNode();
    while(profil)
    {
        profil->data.dropFriend(&(profile1->data)); //profilin arkadaslarindan PROFILI siliyorum.
        Node<Post*>* post1 = profile1->data.getPosts().getFirstNode(); //PROFILIN ilk POSTunu tutuyorum, buraya her gelisimde en bastan tutacagim.
        while(post1) // POSTLARIN icinde geziyorum
        {
            unlikePost(post1->data->getPostId(), profil->data.getEmail()); //profilin PROFIL POSTUna varsa like'ini sil.
            post1 = post1->next; // diger POSTLAR icin tekrarla bitene kadar varsa.
        }
        profile1->data.dropFriend(&(profil->data)); // PROFILIN ARKADASLARINDAN profili cikar.
        profil = profil->next; // siradaki profile gec.
    }

  

    Node<Post*> *post11 = profile1->data.getPosts().getFirstNode(); //bozuk
    while(post11) 
    {
//        (this->posts).removeNode((post11->data));
        Node<Post> *postlar = posts.getFirstNode();
        
        while(postlar)
        {   
            if(post11->data->getPostId() == postlar->data.getPostId() )
            {   
                Node<Post> *tmp = postlar;
                postlar = postlar->next;
                this->posts.removeNode(tmp);
                break;
            }

            postlar = postlar->next;
        }

        Node<Post*> *tmp = post11;
        post11 = post11->next;
        profile1->data.dropPost(tmp->data);   
    }

  


    Node<Post *> *like1 = profile1->data.getLikes().getFirstNode(); // buyuk ihtimal bozuk
    while(like1) 
    {
        Node<Post*> *temp = like1;
        like1 = like1->next;
        profile1->data.dropLike(temp->data); 
    }
    this->profiles.removeNode(profile1); // PROFILi sosyalmedyadan sildim. calisiyor.
}

void SocialNetwork::makeFriends(const std::string &email1, const std::string &email2) {
    Node<Profile> *curr = this->profiles.getFirstNode();
    Node<Profile> *profile1 = NULL;
    Node<Profile> *profile2 = NULL;
    while(curr)
    {
        if(curr->data.getEmail() == email1)
        {
            profile1 = curr;
        }
        if(curr->data.getEmail() == email2)
        {
            profile2 = curr;
        }
        if(profile1 != NULL && profile2 != NULL)
        {
            break;
        }
        curr = curr->next;
    }
    
    profile1->data.addFriend(&(profile2->data));
    profile2->data.addFriend(&(profile1->data));
}

void SocialNetwork::likePost(int postId, const std::string &email) {
    Node<Profile> *curr = this->profiles.getFirstNode();
    Node<Profile> *profile1 = NULL;
    Node<Post> *post = this->posts.getFirstNode();
    while(curr)
    {
        if(curr->data.getEmail() == email)
        {
            profile1 = curr;
            break;
        }
        curr = curr->next;
    }
    while(post)
    {
        if (postId == post->data.getPostId())
        { 
            profile1->data.addLike(&(post->data));
            break;
        }
        post = post->next;
    }
}

void SocialNetwork::unlikePost(int postId, const std::string &email) {
    Node<Profile> *curr = this->profiles.getFirstNode();
    Node<Profile> *profile1 = NULL;
    Node<Post> *post = this->posts.getFirstNode();
    while(curr)
    {
        if(curr->data.getEmail() == email)
        {
            profile1 = curr;
            break;
        }
        curr = curr->next;
    }
    while(post)
    {
        if (post->data.getPostId() == postId)
        { 
            profile1->data.dropLike(&(post->data));
            break;
        }
        post = post->next;
    }
}

LinkedList<Profile *> SocialNetwork::getMutualFriends(const std::string &email1, const std::string &email2) {

    Node<Profile> *curr = this->profiles.getFirstNode();
    Node<Profile> *profile1 = NULL;
    Node<Profile> *profile2 = NULL;
    while(curr)
    {
        if(curr->data.getEmail() == email1)
        {
            profile1 = curr;
        }
        if(curr->data.getEmail() == email2)
        {
            profile2 = curr;
        }
        if(profile1 != NULL && profile2 != NULL)
        {
            break;
        }
        curr = curr->next;
    }
    
    Node<Profile*> *tut1 = profile1->data.getFriends().getFirstNode();
    
    LinkedList<Profile *> mutual;
    while(tut1)
    {   
        Node<Profile*> *tut2 = profile2->data.getFriends().getFirstNode();
        while(tut2)
        {
            if(tut1->data->getEmail() == tut2->data->getEmail())
            {
                mutual.insertAtTheTail(tut1->data);
                break;
            }
            tut2 = tut2->next; 
        }
        tut1 = tut1->next;
    }
    return mutual;
}

LinkedList<Post *> SocialNetwork::getListOfMostRecentPosts(const std::string &email, int k) {
    Node<Profile> *curr = this->profiles.getFirstNode();
    Node<Profile> *profile1 = NULL;
    while(curr)
    {
        if(curr->data.getEmail() == email)
        {
            profile1 = curr;
            break;
        }
        curr = curr->next;
    }
    Node<Post*> *post = profile1->data.getPosts().getLastNode();
    LinkedList<Post *> pozlar;
    for(int i=0; i<k;i++)
    {
        pozlar.insertAtTheTail(post->data);
        post = post->prev;
    }

    return pozlar;
}

void SocialNetwork::print() const {
    std::cout << "# Printing the social network ..." << std::endl;

    std::cout << "# Number of profiles is " << profiles.getNumberOfNodes() << ":" << std::endl;
    profiles.print();

    std::cout << "# Number of posts is " << posts.getNumberOfNodes() << ":" << std::endl;
    posts.print();

    std::cout << "# Printing is done." << std::endl;
}
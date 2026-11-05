#include <iostream>

#include "LinkedList.h"

int main() {
  

    int arra[2]={3,5};
    int size=2;
   	LinkedList<int> llist;
    std::cout<<llist.getNumberOfNodes()<<std::endl;
    llist.insertSorted(4);
    std::cout<<llist.getNumberOfNodes()<<std::endl;
    std::cout<<*(llist.getLastNode())<<std::endl;
    llist.insertSorted(5);
    std::cout<<*(llist.getLastNode())<<std::endl;
    //std::cout<<llist.getNumberOfNodes()<<std::endl;

    //llist.print();

    //llist.removeNode(4);

  //  llist.print();

 //   int* ar = llist.toArray();

//    std::cout<<ar[0]<<" "<<ar[1]<< " "<< std::endl; 

    
    return 0;
}

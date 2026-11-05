#ifndef LINKEDLIST_H
#define LINKEDLIST_H


#include <iostream>

#include "Node.h"

template<class T>
class LinkedList {
public: // DO NOT CHANGE THIS PART.
    LinkedList();
    LinkedList(const T arr[], int arrSize);
    LinkedList(const LinkedList<T> &obj);

    ~LinkedList();

    Node<T> *getFirstNode() const;
    Node<T> *getLastNode() const;
    Node<T> *getNode(const T &data) const;

    int getNumberOfNodes() const;
    bool isEmpty() const;
    bool contains(Node<T> *node) const;

    void insertAtTheHead(const T &data);
    void insertAtTheTail(const T &data);
    void insertSorted(const T &data);

    void removeNode(Node<T> *node);
    void removeNode(const T &data);
    void removeAllNodes();

    void print() const;

    T *toArray() const;

    LinkedList<T> &operator=(const LinkedList<T> &rhs);

private: // YOU MAY ADD YOUR OWN UTILITY MEMBER FUNCTIONS HERE.

private: // DO NOT CHANGE THIS PART.
    Node<T> *head;
    Node<T> *tail;
};

template<class T>
LinkedList<T>::LinkedList() {
    /* TODO */
    this->head = NULL;
    this->tail = NULL;
}

template<class T>
LinkedList<T>::LinkedList(const T arr[], int arrSize) {
    this->head = NULL;
    this->tail = NULL;
    
    for(int i=0; i<arrSize; i++)
    {
        insertAtTheTail(arr[i]);
    }/* TODO */
}

template<class T>
LinkedList<T>::LinkedList(const LinkedList<T> &obj) {
    this->head = NULL;
    this->tail = NULL;
    Node<T> *curr = obj.head;
    
    while(curr)
    {
        insertAtTheTail(curr->data);
        curr = curr->next;
    }
    /* TODO */
}

template<class T>
LinkedList<T>::~LinkedList() {
    /* TODO */
    while (head){
        Node<T> *tmp = head;
        head = head->next;
        delete tmp;
    }
//    delete tail;
}

template<class T>
Node<T> *LinkedList<T>::getFirstNode() const {
    if( head == NULL )
    {
        return nullptr;
    }
    else
    {
        return head;
    }
    /* TODO */
}

template<class T>
Node<T> *LinkedList<T>::getLastNode() const {
    if( head == NULL )
    {
        return nullptr;
    }
    else
    {
        return tail;
    }
    /* TODO */
}

template<class T>
Node<T> *LinkedList<T>::getNode(const T &data) const {
    Node<T> *curr = head;
    
    while(curr)
    {
        if( curr->data == data )
        {
            return curr;
        }
        curr = curr->next;
    }
    return nullptr;
    /* TODO */
}

template<class T>
int LinkedList<T>::getNumberOfNodes() const {
    
    Node<T> *curr = head;
    int count = 0;
    while(curr)
    {
        count++;
        curr = curr->next;
    }
    return count;
    
    /* TODO */
}

template<class T>
bool LinkedList<T>::isEmpty() const {
    
    return head == NULL;
    /* TODO */
}

template<class T>
bool LinkedList<T>::contains(Node<T> *node) const {
    
    Node<T> *curr = head;

    while(curr)
    {
        if(curr->data == node->data && curr->prev == node->prev && curr->next == node->next)
        {
            return 1;
        }
        curr = curr->next;
    }
    return 0;
    /* TODO */
}

template<class T>
void LinkedList<T>::insertAtTheHead(const T &data) {
    
    if( head == NULL )
    {
        Node<T> *curr = new Node<T>(data, NULL, NULL);
        head = curr;
        tail = curr;
    }
    else
    {
        Node<T> *curr = new Node<T>(data, NULL, NULL);
        head->prev = curr;
        curr->next = head;
        head = curr;
    }
    /* TODO */
}

template<class T>
void LinkedList<T>::insertAtTheTail(const T &data) {
    
    if( head == NULL )
    {   Node<T> *curr = new Node<T>(data, NULL, NULL);
        head = curr;
        tail = curr;
    }
    else
    {   Node<T> *curr = new Node<T>(data, NULL, NULL);
        tail->next = curr;
        curr->prev = tail;
        tail = curr;
    }
    /* TODO */
}

template<class T>
void LinkedList<T>::insertSorted(const T &data) { //buraya bak
    Node<T> *curr = head;
    
    if(head == NULL)
    {
        insertAtTheHead(data);
        return;
    }
    if( curr->data > data)
    {
        insertAtTheHead(data);
        return;
    }else if( tail->data <= data )
    {
        insertAtTheTail(data);
        return;
    }
    else
    {
        while(curr)
        {
            if( curr->data > data )
            {
                Node<T> *tmp = new Node<T>(data, NULL, NULL);
                tmp->next = curr;
                tmp->prev = curr->prev;
                curr->prev->next = tmp;
                curr->prev = tmp;        
                return;
            }
            curr = curr->next;
        }    
    }
}    

// Function to delete a node in a Doubly Linked List.
// head_ref --> pointer to head node pointer.
// del --> data of node to be deleted.

template<class T>
void LinkedList<T>::removeNode(Node<T> *node) {
    
    if(contains(node) == 0 || head == NULL)
    {
        return;
    }
    if(head == node)
    {
        head = head->next;
    }
    if( node->next != NULL)
    {
        node->next->prev = node->prev;
    }else
    {
        tail = node->next;   
    }
    if( node->prev != NULL)
    {
        node->prev->next = node->next;
    }
    delete node;
}
    /* TODO */

template<class T>
void LinkedList<T>::removeNode(const T &data) {

    if(head == NULL)
    {
        return;
    }
    Node<T> *curr = head;
    while(curr)
    {
        if(curr->data == data)
        {
            if(curr == head)
            {
                if(head == tail)
                {
                    delete curr;
                    head = NULL;
                    tail = NULL;
                    break;
                }else
                {
                    head = head->next;
                    head->prev = NULL;
                    delete curr;
                    break;
                }
            }
            if(curr == tail)
            {
                tail = tail->prev;
                tail->next = NULL;
                delete curr;
                break;
            }
            curr->next->prev = curr->prev;
            curr->prev->next = curr->next;
            delete curr;
            break;
        }
        curr = curr->next;
    }
    return;
}

template<class T>
void LinkedList<T>::removeAllNodes() {

    while(head)
    {
        Node<T> *tmp = head;
        head = head->next;
        delete tmp;
    }
    head = NULL;
    tail = NULL;
    /* TODO */
}

template<class T>
void LinkedList<T>::print() const {
   std::cout << "Printing the linked list ..." << std::endl;

    if (this->isEmpty()) {
        std::cout << "empty" << std::endl;
        return;
    }

    Node<T> *node = this->head;

    while (node) {
        std::cout << *node << std::endl;
        node = node->next;
    }
}

template<class T>
T *LinkedList<T>::toArray() const {
    int i = getNumberOfNodes();
    if( i == 0)
    {
        return nullptr;
    }
    T *arr;
    arr = new T[i];
    Node<T> *curr = head;
    int j = 0;
    while(j<i)
    {
        arr[j] = curr->data;
        j++;
        curr = curr->next;
    }
    return arr;
}

template<class T>
LinkedList<T> &LinkedList<T>::operator=(const LinkedList<T> &rhs) {
    if(this != &rhs)
    {
        removeAllNodes();
        Node<T> *curr = rhs.head;
        
        while(curr)
        {
            insertAtTheTail(curr->data);
            curr = curr->next;
        }
    }

    return *this;
    /* TODO */
}


#endif //LINKEDLIST_H

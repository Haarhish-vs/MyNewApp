import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  RefreshControl,
  ActivityIndicator,
  FlatList,
  Linking
} from 'react-native';
import { FontAwesome5, Ionicons } from '@expo/vector-icons';
import { collection, query, where, onSnapshot, updateDoc, doc, serverTimestamp, arrayUnion } from 'firebase/firestore';
import { db, auth } from '../services/auth';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';
import { sendPushNotification } from '../services/backendClient';
import { fetchUserFcmToken } from '../services/userService';

const skeletonPlaceholders = [0, 1];

const SkeletonLine = ({ width = '100%', height = 12 }) => (
  <View style={[styles.skeletonLine, { width, height }]} />
);

const renderRequestSkeletons = () =>
  skeletonPlaceholders.map((index) => (
    <View key={`request-skeleton-${index}`} style={[styles.card, styles.requestCard, styles.skeletonCard]}>
      <View style={[styles.skeletonBadge, { width: 120 }]} />
      <View style={styles.skeletonBody}>
        <SkeletonLine width="70%" />
        <SkeletonLine width="50%" />
        <SkeletonLine width="90%" />
        <SkeletonLine width="60%" />
        <SkeletonLine width="80%" />
      </View>
      <View style={styles.skeletonButtonRow}>
        <View style={styles.skeletonButton} />
        <View style={styles.skeletonButton} />
      </View>
    </View>
  ));

const renderResponseSkeletons = () =>
  skeletonPlaceholders.map((index) => (
    <View key={`response-skeleton-${index}`} style={[styles.card, styles.responseCard, styles.skeletonCard]}>
      <View style={[styles.skeletonBadge, { width: 150 }]} />
      <View style={styles.skeletonBody}>
        <SkeletonLine width="80%" />
        <SkeletonLine width="60%" />
        <SkeletonLine width="55%" />
        <SkeletonLine width="75%" />
        <SkeletonLine width="45%" />
      </View>
      <View style={styles.skeletonButtonRow}>
        <View style={[styles.skeletonButton, { width: '60%' }]} />
      </View>
    </View>
  ));

export default function NotificationsScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  
  const [userRole, setUserRole] = useState(null); // 'donor' or 'receiver'
  const [userCity, setUserCity] = useState('');
  const [userBloodGroup, setUserBloodGroup] = useState('');
  const [userProfile, setUserProfile] = useState(null);
  const [requests, setRequests] = useState([]); // For donor: matched requests
  const [responses, setResponses] = useState([]); // For receiver: donor responses
  const [newNotificationCount, setNewNotificationCount] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [userLoading, setUserLoading] = useState(true);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [responsesLoading, setResponsesLoading] = useState(true);
  const [requestsReady, setRequestsReady] = useState(false);
  const [responsesReady, setResponsesReady] = useState(false);
  const [receiverDocs, setReceiverDocs] = useState([]);
  const [hasReceiverRequests, setHasReceiverRequests] = useState(false);
  const [donorProfile, setDonorProfile] = useState(null);
  const [donorCity, setDonorCity] = useState('');
  const [donorBloodGroup, setDonorBloodGroup] = useState('');
  const matchingCity = donorCity || userCity;
  const matchingBloodGroup = donorBloodGroup || userBloodGroup;

  const ensureText = useCallback((value, fallback) => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length ? trimmed : fallback;
    }
    if (value === null || value === undefined) {
      return fallback;
    }
    return value;
  }, []);

  const ensureNumberText = useCallback((value, fallback = '1') => {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length ? trimmed : fallback;
    }
    return fallback;
  }, []);
  const hasEssentialRequestData = useCallback((data) => {
    if (!data) return false;
    const hasLocation = typeof data.city === 'string' && data.city.trim().length > 0;
    const hasBloodGroup = typeof data.bloodGroup === 'string' && data.bloodGroup.trim().length > 0;
    return hasLocation && hasBloodGroup;
  }, []);

  const hasEssentialResponseData = useCallback((response, requestData) => {
    if (!response) return false;
    const donorGroup = typeof response.donorBloodGroup === 'string' && response.donorBloodGroup.trim().length > 0;
    const fallbackGroup = typeof requestData?.bloodGroup === 'string' && requestData.bloodGroup.trim().length > 0;
    const hasStatus = typeof response.status === 'string' && response.status.trim().length > 0;
    return hasStatus && (donorGroup || fallbackGroup);
  }, []);
  const formatDateTime = useCallback((dateValue) => {
    if (!dateValue) return null;
    try {
      let dateObj;
      if (dateValue.toDate && typeof dateValue.toDate === 'function') {
        dateObj = dateValue.toDate();
      } else if (dateValue instanceof Date) {
        dateObj = dateValue;
      } else if (typeof dateValue === 'string' || typeof dateValue === 'number') {
        dateObj = new Date(dateValue);
      }
      if (dateObj instanceof Date && !isNaN(dateObj.getTime())) {
        return (
          dateObj.toLocaleDateString() +
          ' at ' +
          dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        );
      }
      if (typeof dateValue === 'string' && dateValue.trim()) {
        return dateValue;
      }
      return null;
    } catch (err) {
      console.log('Error formatting date:', err);
      return null;
    }
  }, []);
  const receiverDocListenersRef = useRef({});
  const receiverDocMapRef = useRef({});
  const [receiverDocMap, setReceiverDocMap] = useState({});

  const flushReceiverDocMap = useCallback(() => {
    setReceiverDocMap({ ...receiverDocMapRef.current });
  }, []);

  const detachReceiverDocListeners = useCallback(() => {
    Object.values(receiverDocListenersRef.current).forEach((unsubscribe) => {
      try {
        unsubscribe();
      } catch (cleanupError) {
        console.log('Error detaching receiver listener', cleanupError);
      }
    });
    receiverDocListenersRef.current = {};
    receiverDocMapRef.current = {};
    setReceiverDocMap({});
  }, []);

  const upsertReceiverDocEntry = useCallback((docId, data) => {
    if (!data) {
      if (receiverDocMapRef.current[docId]) {
        delete receiverDocMapRef.current[docId];
        flushReceiverDocMap();
      }
      return;
    }
    receiverDocMapRef.current[docId] = data;
    flushReceiverDocMap();
  }, [flushReceiverDocMap]);
  const buildReceiverResponses = useCallback(
    (docs) => {
      if (!Array.isArray(docs) || docs.length === 0) {
        return [];
      }

      const highlightRequestId = route?.params?.highlightRequestId;
      const highlightDonorName = route?.params?.donorName;
      const highlightStatus = route?.params?.status;

      return docs
        .flatMap(({ id: docId, data }) => {
          if (!data || !Array.isArray(data.responses) || data.responses.length === 0) {
            return [];
          }

          const patientName = ensureText(data.name || data.patientName, 'Anonymous Patient');
          const patientCity = ensureText(data.city, 'Not specified');
          const patientHospital = ensureText(data.hospital, 'Not specified');
          const patientPurpose = ensureText(data.purpose, 'Medical need');
          const patientUnits = ensureNumberText(data.bloodUnits, '1');
          const patientBloodGroup = ensureText(data.bloodGroup, 'Unknown');
          const patientMobile = ensureText(data.mobile, '');

          return data.responses
            .map((response, index) => {
              if (!hasEssentialResponseData(response, data)) {
                return null;
              }

              const respondedAtValue = response.respondedAt || new Date();

              return {
                id: `${docId}_${index}`,
                requestId: docId,
                donorUid: response.donorUid || '',
                donorName: ensureText(response.donorName, 'Anonymous Donor'),
                donorMobile: ensureText(response.donorMobile, ''),
                donorBloodGroup: ensureText(response.donorBloodGroup || data.bloodGroup, 'Unknown'),
                donorCity: ensureText(response.donorCity || data.city, 'Not specified'),
                status: ensureText(response.status, 'pending'),
                respondedAt: respondedAtValue,
                seenByReceiver: !!response.seenByReceiver,
                formattedResponseTime: formatDateTime(respondedAtValue) || 'Recently',
                requestData: {
                  patientName,
                  contactMobile: patientMobile,
                  purpose: patientPurpose,
                  bloodGroup: patientBloodGroup,
                  bloodUnits: patientUnits,
                  city: patientCity,
                  hospital: patientHospital,
                  formattedRequiredTime: formatDateTime(data.requiredDateTime) || 'As soon as possible',
                  status: ensureText(data.status, 'pending'),
                },
                isHighlighted:
                  docId === highlightRequestId &&
                  response.donorName === highlightDonorName &&
                  response.status === highlightStatus,
              };
            })
            .filter(Boolean);
        })
        .sort((a, b) => {
          const aTime = a.respondedAt?.toDate ? a.respondedAt.toDate() : new Date(a.respondedAt || 0);
          const bTime = b.respondedAt?.toDate ? b.respondedAt.toDate() : new Date(b.respondedAt || 0);
          return bTime - aTime;
        });
    },
    [
      ensureNumberText,
      ensureText,
      formatDateTime,
      hasEssentialResponseData,
      route?.params?.donorName,
      route?.params?.highlightRequestId,
      route?.params?.status,
    ]
  );
  const lastSeenMarkTime = useRef(0);

  const notifyReceiverAboutResponse = useCallback(
    async ({ receiverUid, requestId, donorName, status }) => {
      try {
        if (!receiverUid) {
          return;
        }

        const token = await fetchUserFcmToken(receiverUid);
        if (!token) {
          return;
        }

        const isAccepted = status === 'accepted';
        const title = isAccepted
          ? 'A donor accepted your request'
          : 'Update on your blood request';
        const body = isAccepted
          ? `${donorName || 'A donor'} can donate ${userBloodGroup} blood in ${userCity}.`
          : `${donorName || 'A donor'} is unavailable right now.`;

        await sendPushNotification(token, {
          title,
          body,
          data: {
            type: 'donor_response',
            requestId,
            status,
            donorName: donorName || 'A donor',
          },
        });
      } catch (error) {
        console.log('Failed to notify receiver about donor response', error);
      }
    },
    [userBloodGroup, userCity]
  );
  
  // Function to handle phone calls
  const handlePhoneCall = (phoneNumber) => {
    if (!phoneNumber) {
      Alert.alert('Error', 'No phone number available');
      return;
    }
    
    let formattedNumber = phoneNumber;
    // Remove any non-numeric characters
    formattedNumber = formattedNumber.replace(/[^\d+]/g, '');
    
    // Add tel: prefix for linking
    const phoneUrl = `tel:${formattedNumber}`;
    
    Linking.canOpenURL(phoneUrl)
      .then(supported => {
        if (supported) {
          return Linking.openURL(phoneUrl);
        } else {
          Alert.alert('Error', 'Phone calls are not supported on this device');
        }
      })
      .catch(err => {
        console.error('Error making phone call:', err);
        Alert.alert('Error', 'Could not make phone call');
      });
  };

  // Mark all notifications as seen when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      if (userRole && auth.currentUser?.uid) {
        // Mark notifications as seen without showing loading state
        markAllAsSeen();
        
        // Only show loading state if we don't have data already
        if (userRole === 'receiver' && responses.length === 0) {
          setResponsesLoading(true);
        } else if (userRole === 'donor' && requests.length === 0) {
          setRequestsLoading(true);
        }
      }
    }, [userRole, userCity, userBloodGroup, auth.currentUser?.uid, responses.length, requests.length])
  );

  // Function to mark all notifications as seen (with debouncing)
  const markAllAsSeen = async () => {
    // Debounce: only run if at least 3 seconds have passed since last call
    const now = Date.now();
    if (now - lastSeenMarkTime.current < 3000) {
      return;
    }
    lastSeenMarkTime.current = now;
    
    try {
      const currentUser = auth.currentUser;
      if (!currentUser) {
        return;
      }

      if (userRole === 'donor') {
        const unseen = requests.filter((request) => request.isNew);
        if (unseen.length) {
          await Promise.all(
            unseen.map((request) =>
              updateDoc(doc(db, 'Bloodreceiver', request.id), {
                seenBy: arrayUnion(currentUser.uid),
              })
            )
          );
        }
      } else if (userRole === 'receiver') {
        const receiverUpdates = receiverDocs
          .map(({ id, data }) => {
            if (!Array.isArray(data.responses) || data.responses.length === 0) {
              return null;
            }
            const hasUnseenResponses = data.responses.some((response) => !response.seenByReceiver);
            if (!hasUnseenResponses) {
              return null;
            }
            const updatedResponses = data.responses.map((response) => ({
              ...response,
              seenByReceiver: true,
            }));
            return updateDoc(doc(db, 'Bloodreceiver', id), {
              responses: updatedResponses,
            });
          })
          .filter(Boolean);

        if (receiverUpdates.length) {
          await Promise.all(receiverUpdates);
        }
      }

      setNewNotificationCount(0);
    } catch (error) {
      console.error('Error marking notifications as seen:', error);
    }
  };

  // Live user profile listener
  useEffect(() => {
    const currentUser = auth.currentUser;
    if (!currentUser) {
      setUserProfile(null);
      setUserCity('');
      setUserBloodGroup('');
      setUserLoading(false);
      return () => {};
    }

    setUserLoading(true);
    const userDocRef = doc(db, 'users', currentUser.uid);
    const unsubscribe = onSnapshot(
      userDocRef,
      (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.data();
          setUserProfile(data);
          setUserCity(data.city || '');
          setUserBloodGroup(data.bloodGroup || '');
        } else {
          setUserProfile(null);
          setUserCity('');
          setUserBloodGroup('');
        }
        setUserLoading(false);
      },
      (error) => {
        console.error('Error listening to user profile:', error);
        setUserLoading(false);
      }
    );

    return () => unsubscribe();
  }, [auth.currentUser?.uid]);

  // Live donor profile listener (city/blood group for matching)
  useEffect(() => {
    const currentUser = auth.currentUser;
    if (!currentUser) {
      setDonorProfile(null);
      setDonorCity('');
      setDonorBloodGroup('');
      return () => {};
    }

    const donorQuery = query(
      collection(db, 'BloodDonors'),
      where('uid', '==', currentUser.uid)
    );

    const unsubscribe = onSnapshot(
      donorQuery,
      (snapshot) => {
        if (!snapshot.empty) {
          const donorDoc = snapshot.docs[0];
          const donorData = { id: donorDoc.id, ...donorDoc.data() };
          setDonorProfile(donorData);
          setDonorCity(donorData.city || '');
          setDonorBloodGroup(donorData.bloodGroup || '');
        } else {
          setDonorProfile(null);
          setDonorCity('');
          setDonorBloodGroup('');
        }
      },
      (error) => {
        console.error('Error listening to donor profile:', error);
      }
    );

    return () => unsubscribe();
  }, [auth.currentUser?.uid]);

  useEffect(() => {
    if (hasReceiverRequests) {
      setUserRole('receiver');
    } else if (donorProfile) {
      setUserRole('donor');
    } else {
      setUserRole(null);
    }
  }, [hasReceiverRequests, donorProfile]);

  // Listen for matching blood requests (for donors)
  useEffect(() => {
    if (!userRole || userRole !== 'donor' || !matchingCity || !matchingBloodGroup || !auth.currentUser?.uid) {
      setRequests([]);
      setNewNotificationCount(0);
      setRequestsLoading(false);
      setRequestsReady(false);
      return () => {};
    }

    setRequestsReady(false);
    setRequestsLoading(true);

    const donorQuery = query(
      collection(db, 'Bloodreceiver'),
      where('bloodGroup', '==', matchingBloodGroup),
      where('city', '==', matchingCity),
      where('status', '==', 'pending')
    );

    const buildDonorMatches = (docs) =>
      docs
        .map((docSnapshot) => {
          const data = docSnapshot.data();
          if (!hasEssentialRequestData(data)) {
            return null;
          }

          const seenBy = Array.isArray(data.seenBy) ? data.seenBy : [];
          const hasResponded = Array.isArray(data.responses)
            ? data.responses.some((response) => response.donorUid === auth.currentUser?.uid)
            : false;

          if (hasResponded) {
            return null;
          }

          return {
            id: docSnapshot.id,
            name: ensureText(data.name, 'Anonymous Patient'),
            bloodGroup: ensureText(data.bloodGroup, 'Unknown'),
            bloodUnits: ensureNumberText(data.bloodUnits),
            city: ensureText(data.city, 'Not specified'),
            purpose: ensureText(data.purpose, 'Medical need'),
            hospital: ensureText(data.hospital, ''),
            mobile: ensureText(data.mobile, ''),
            requiredDateTime: data.requiredDateTime || null,
            createdAt: data.createdAt || null,
            status: ensureText(data.status, 'pending'),
            uid: data.uid || '',
            formattedDate: formatDateTime(data.requiredDateTime) || 'As soon as possible',
            isNew: !seenBy.includes(auth.currentUser?.uid),
            isHighlighted: docSnapshot.id === route?.params?.highlightRequestId,
          };
        })
        .filter(Boolean)
        .sort((a, b) => {
          const aTime = a.requiredDateTime?.toDate ? a.requiredDateTime.toDate() : new Date(a.requiredDateTime || Date.now());
          const bTime = b.requiredDateTime?.toDate ? b.requiredDateTime.toDate() : new Date(b.requiredDateTime || Date.now());
          return aTime - bTime;
        });

    const unsubscribe = onSnapshot(
      donorQuery,
      (snapshot) => {
        try {
          const formatted = buildDonorMatches(snapshot.docs);
          setRequests(formatted);
          setNewNotificationCount(formatted.filter((item) => item.isNew).length);
        } catch (listenerError) {
          console.error('Error processing donor notifications:', listenerError);
          setRequests([]);
        } finally {
          setRequestsReady(true);
          setRequestsLoading(false);
        }
      },
      (error) => {
        console.error('Error listening to donor notifications:', error);
        setRequests([]);
        setRequestsReady(true);
        setRequestsLoading(false);
      }
    );

    return () => {
      unsubscribe();
    };
  }, [userRole, matchingCity, matchingBloodGroup, auth.currentUser?.uid, route?.params, ensureNumberText, ensureText, formatDateTime, hasEssentialRequestData]);

  // Listen for donor responses (for receivers)
  useEffect(() => {
    const currentUid = auth.currentUser?.uid;
    if (!currentUid) {
      detachReceiverDocListeners();
      setResponses([]);
      setResponsesLoading(false);
      setResponsesReady(false);
      setHasReceiverRequests(false);
      setReceiverDocs([]);
      setReceiverDocMap({});
      return () => {};
    }

    setResponsesReady(false);
    setResponsesLoading(true);

    const receiverQuery = query(
      collection(db, 'Bloodreceiver'),
      where('uid', '==', currentUid)
    );

    const removeDocListener = (docId) => {
      const unsubscribeDoc = receiverDocListenersRef.current[docId];
      if (unsubscribeDoc) {
        try {
          unsubscribeDoc();
        } catch (cleanupError) {
          console.log('Error detaching receiver doc listener', cleanupError);
        }
        delete receiverDocListenersRef.current[docId];
      }
      upsertReceiverDocEntry(docId, null);
    };

    const attachDocListener = (docId) => {
      const docRef = doc(db, 'Bloodreceiver', docId);
      const unsubscribeDoc = onSnapshot(
        docRef,
        (docSnapshot) => {
          upsertReceiverDocEntry(docId, docSnapshot.exists() ? docSnapshot.data() : null);
        },
        (docError) => {
          console.error(`Error listening to receiver request ${docId}:`, docError);
        }
      );
      receiverDocListenersRef.current[docId] = unsubscribeDoc;
    };

    const unsubscribe = onSnapshot(
      receiverQuery,
      (snapshot) => {
        try {
          if (snapshot.empty) {
            setHasReceiverRequests(false);
            detachReceiverDocListeners();
            setReceiverDocs([]);
            setResponses([]);
            setNewNotificationCount(0);
            setReceiverDocMap({});
          } else {
            setHasReceiverRequests(true);
            const currentDocIds = new Set();

            snapshot.docs.forEach((docSnapshot) => {
              const docId = docSnapshot.id;
              currentDocIds.add(docId);
              upsertReceiverDocEntry(docId, docSnapshot.data());
              if (!receiverDocListenersRef.current[docId]) {
                attachDocListener(docId);
              }
            });

            Object.keys(receiverDocListenersRef.current).forEach((docId) => {
              if (!currentDocIds.has(docId)) {
                removeDocListener(docId);
              }
            });
          }
        } catch (listenerError) {
          console.error('Error processing receiver notifications:', listenerError);
          setResponses([]);
        } finally {
          setResponsesReady(true);
          setResponsesLoading(false);
        }
      },
      (error) => {
        console.error('Error listening to receiver notifications:', error);
        setResponses([]);
        setResponsesReady(true);
        setResponsesLoading(false);
        setHasReceiverRequests(false);
        setReceiverDocs([]);
        detachReceiverDocListeners();
        setReceiverDocMap({});
      }
    );

    return () => {
      unsubscribe();
      detachReceiverDocListeners();
    };
  }, [auth.currentUser?.uid]);

  useEffect(() => {
    const docEntries = Object.entries(receiverDocMap)
      .filter(([, data]) => !!data)
      .map(([id, data]) => ({ id, data }));

    setReceiverDocs(docEntries);

    if (!docEntries.length) {
      setResponses([]);
      setNewNotificationCount(0);
      return;
    }

    const formatted = buildReceiverResponses(docEntries);
    setResponses(formatted);
    setNewNotificationCount(formatted.filter((item) => !item.seenByReceiver).length);
  }, [receiverDocMap, buildReceiverResponses]);

  // Handle donor accepting a blood request
  const handleAccept = (requestId) => {
    Alert.alert(
      'Accept Blood Request',
      'Are you sure you want to accept this blood donation request?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Accept',
          onPress: async () => {
            try {
              const currentUser = auth.currentUser;
              const donorName = userProfile?.name || 'A donor';
              const donorMobile = userProfile?.mobile || userProfile?.phone || '';
              const targetRequest = requests.find((req) => req.id === requestId);
              const receiverUid = targetRequest?.uid;

              if (!receiverUid) {
                Alert.alert('Request Unavailable', 'This request is no longer active.');
                return;
              }
              
              // Create response
              const newResponse = {
                donorUid: currentUser?.uid,
                donorName: donorName,
                donorMobile: donorMobile,
                status: 'accepted',
                respondedAt: new Date().toISOString(),
                seenByReceiver: false,
                donorBloodGroup: userBloodGroup,
                donorCity: userCity,
              };
              
              // Update the request document
              await updateDoc(doc(db, 'Bloodreceiver', requestId), {
                responses: arrayUnion(newResponse),
                seenBy: arrayUnion(currentUser?.uid),
                respondedBy: donorName,
                status: 'accepted',
                lastUpdated: serverTimestamp(),
              });

              await notifyReceiverAboutResponse({
                receiverUid,
                requestId,
                donorName,
                status: 'accepted',
              });
              
              // Remove accepted request from local state immediately
              setRequests(prevRequests => prevRequests.filter(req => req.id !== requestId));
              
              // Show success message and navigate to home
              Alert.alert(
                'Success', 
                'You have accepted the blood donation request!',
                [
                  { 
                    text: 'OK', 
                    onPress: () => {
                      if (navigation.canGoBack()) {
                        navigation.goBack();
                      } else {
                        navigation.navigate('Home');
                      }
                    }
                  }
                ]
              );
            } catch (error) {
              console.error('Error accepting request:', error);
              Alert.alert('Error', 'Failed to accept request: ' + error.message);
            }
          },
        },
      ]
    );
  };

  // Handle donor declining a blood request
  const handleDecline = (requestId) => {
    Alert.alert(
      'Decline Blood Request',
      'Are you sure you want to decline this blood donation request?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Decline',
          style: 'destructive',
          onPress: async () => {
            try {
              const currentUser = auth.currentUser;
              const donorName = userProfile?.name || 'A donor';
              const donorMobile = userProfile?.mobile || userProfile?.phone || '';
              const targetRequest = requests.find((req) => req.id === requestId);
              const receiverUid = targetRequest?.uid;

              if (!receiverUid) {
                Alert.alert('Request Unavailable', 'This request is no longer active.');
                return;
              }
              
              // Create response
              const newResponse = {
                donorUid: currentUser?.uid,
                donorName: donorName,
                donorMobile: donorMobile,
                status: 'declined',
                respondedAt: new Date().toISOString(),
                seenByReceiver: false,
                donorBloodGroup: userBloodGroup,
                donorCity: userCity,
              };
              
              // Update the request document
              await updateDoc(doc(db, 'Bloodreceiver', requestId), {
                responses: arrayUnion(newResponse),
                seenBy: arrayUnion(currentUser?.uid),
                lastUpdated: serverTimestamp(),
              });

              await notifyReceiverAboutResponse({
                receiverUid,
                requestId,
                donorName,
                status: 'declined',
              });
              
              // Remove declined request from local state immediately
              setRequests(prevRequests => prevRequests.filter(req => req.id !== requestId));
              
              // Show message and navigate to home
              Alert.alert(
                'Request Declined', 
                'You have declined the blood donation request.',
                [
                  { 
                    text: 'OK', 
                    onPress: () => {
                      if (navigation.canGoBack()) {
                        navigation.goBack();
                      } else {
                        navigation.navigate('Home');
                      }
                    }
                  }
                ]
              );
            } catch (error) {
              console.error('Error declining request:', error);
              Alert.alert('Error', 'Failed to decline request: ' + error.message);
            }
          },
        },
      ]
    );
  };

  // Refresh handler
  const handleRefresh = () => {
    setRefreshing(true);
    
    // Reset highlight params
    if (navigation) {
      navigation.setParams({
        highlightRequestId: null,
        donorName: null,
        status: null
      });
    }
    
    // Mark all as seen again without triggering loading state
    markAllAsSeen().finally(() => {
      setRefreshing(false);
    });
  };

  // Loading state - only show on initial load
  if (userLoading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#b71c1c" />
        <Text style={styles.loadingText}>Loading notifications...</Text>
      </View>
    );
  }

  if (userRole === 'donor' && !requestsReady) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="\#b71c1c" />
        <Text style={styles.loadingText}>Preparing matches...</Text>
      </View>
    );
  }

  if (userRole === 'receiver' && !responsesReady) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="\#b71c1c" />
        <Text style={styles.loadingText}>Preparing responses...</Text>
      </View>
    );
  }

  // No profile state
  if (!userProfile || !userCity || !userBloodGroup) {
    return (
      <View style={styles.centerContainer}>
        <Ionicons name="person-circle-outline" size={60} color="#999" />
        <Text style={styles.noProfileText}>Please complete your profile first</Text>
        <TouchableOpacity
          style={styles.setupButton}
          onPress={() => navigation.navigate('MyProfile')}
        >
          <Text style={styles.setupButtonText}>Set Up Profile</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Donor view
  if (userRole === 'donor') {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Blood Request Matches</Text>
          {newNotificationCount > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{newNotificationCount}</Text>
            </View>
          )}
        </View>
        
        {requestsLoading && requests.length === 0 ? (
          <View style={styles.listContent}>
            {renderRequestSkeletons()}
          </View>
        ) : requests.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Ionicons name="water-outline" size={60} color="#999" />
            <Text style={styles.emptyText}>No matching blood requests found</Text>
            <Text style={styles.emptySubtext}>You'll be notified when someone needs your blood type</Text>
          </View>
        ) : (
          <FlatList
            data={requests}
            extraData={requests.length} 
            keyExtractor={item => item?.id || `fallback-key-${Math.random()}`}
            renderItem={({ item, index }) => {
              if (!item || typeof item !== 'object') {
                return null;
              }

              const patientName = ensureText(item.name, 'Anonymous Patient');
              const patientPurpose = ensureText(item.purpose, 'Medical need');
              const patientCity = ensureText(item.city, 'Not specified');
              const patientHospital = ensureText(item.hospital, '');
              const patientMobile = ensureText(item.mobile, '');
              const bloodUnitsNeeded = ensureNumberText(item.bloodUnits);
              const bloodGroupNeeded = ensureText(item.bloodGroup, 'Unknown');
              const formattedRequired = ensureText(item.formattedDate, 'As soon as possible');

              return (
              <View style={[
                styles.card,
                styles.requestCard,
                item.isHighlighted && styles.highlightedCard,
                item.isNew && styles.newCard
              ]}>
                <View style={styles.cardHeader}>
                  <View style={styles.urgentBadge}>
                    <Text style={styles.urgentText}>URGENT REQUEST</Text>
                  </View>
                  {item.isNew && (
                    <View style={styles.newBadge}>
                      <Text style={styles.newBadgeText}>NEW</Text>
                    </View>
                  )}
                </View>
                
                <View style={styles.requestInfo}>
                  <View style={styles.infoRow}>
                    <Text style={styles.requestLabel}>Patient:</Text>
                    <Text style={styles.requestValue}>{patientName}</Text>
                  </View>
                  
                  <View style={styles.infoRow}>
                    <Text style={styles.requestLabel}>Blood Group:</Text>
                    <Text style={styles.bloodType}>{bloodGroupNeeded}</Text>
                  </View>
                  
                  <View style={styles.infoRow}>
                    <Text style={styles.requestLabel}>Units Needed:</Text>
                    <Text style={styles.requestValue}>{bloodUnitsNeeded}</Text>
                  </View>
                  
                  <View style={styles.infoRow}>
                    <Text style={styles.requestLabel}>Location:</Text>
                    <Text style={styles.requestValue}>{patientCity}</Text>
                  </View>
                  
                  <View style={styles.infoRow}>
                    <Text style={styles.requestLabel}>Purpose:</Text>
                    <Text style={styles.requestValue}>{patientPurpose}</Text>
                  </View>
                  
                  {patientHospital ? (
                    <View style={styles.infoRow}>
                      <Text style={styles.requestLabel}>Hospital:</Text>
                      <Text style={styles.requestValue}>{patientHospital}</Text>
                    </View>
                  ) : null}
                  
                  <View style={styles.infoRow}>
                    <Text style={styles.requestLabel}>Required By:</Text>
                    <Text style={styles.urgentValue}>{formattedRequired}</Text>
                  </View>
                  
                  {patientMobile ? (
                    <View style={styles.infoRow}>
                      <Text style={styles.requestLabel}>Contact:</Text>
                      <TouchableOpacity onPress={() => handlePhoneCall(patientMobile)}>
                        <Text style={styles.phoneValue}>{patientMobile}</Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                </View>
                
                <View style={styles.timeInfo}>
                  <Text style={styles.timeText}>
                    <Ionicons name="time-outline" size={12} color="#666" /> 
                    {item.createdAt?.toDate ? 
                      new Date(item.createdAt.toDate()).toLocaleString() : 
                      'Recently'}
                  </Text>
                </View>
                
                <View style={styles.actionButtons}>
                  <TouchableOpacity 
                    style={[styles.actionButton, styles.acceptButton]} 
                    onPress={() => handleAccept(item.id)}
                  >
                    <Text style={styles.actionButtonText}>Accept</Text>
                  </TouchableOpacity>
                  
                  <TouchableOpacity 
                    style={[styles.actionButton, styles.declineButton]} 
                    onPress={() => handleDecline(item.id)}
                  >
                    <Text style={styles.actionButtonText}>Decline</Text>
                  </TouchableOpacity>
                </View>
              </View>
              );
            }}
            refreshControl={
              <RefreshControl 
                refreshing={refreshing}
                onRefresh={handleRefresh}
                colors={['#b71c1c']}
              />
            }
            contentContainerStyle={styles.listContent}
            removeClippedSubviews={false}
            maxToRenderPerBatch={10}
            updateCellsBatchingPeriod={100}
            initialNumToRender={5}
            windowSize={10}
          />
        )}
      </View>
    );
  }

  // Receiver view
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Donor Responses</Text>
        {newNotificationCount > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{newNotificationCount}</Text>
          </View>
        )}
      </View>
      
      {responsesLoading && responses.length === 0 ? (
        <View style={styles.listContent}>
          {renderResponseSkeletons()}
        </View>
      ) : responses.length === 0 ? (
        <View style={styles.emptyContainer}>
          <FontAwesome5 name="hand-holding-heart" size={60} color="#999" />
          <Text style={styles.emptyText}>No donor responses yet</Text>
          <Text style={styles.emptySubtext}>When donors respond to your requests, they'll appear here</Text>
        </View>
      ) : (
        <FlatList
          data={responses}
          extraData={responses}
          keyExtractor={item => item?.id || `fallback-key-${Math.random()}`}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <FontAwesome5 name="hand-holding-heart" size={60} color="#999" />
              <Text style={styles.emptyText}>No donor responses yet</Text>
              <Text style={styles.emptySubtext}>When donors respond to your requests, they'll appear here</Text>
            </View>
          }
          renderItem={({ item, index }) => {
            if (!item || typeof item !== 'object') {
              return null;
            }
            
            // Check for minimum required data to render a proper card
            const hasMinimalData = item.donorName || 
                                 (item.requestData && 
                                  (item.requestData.bloodGroup || 
                                   item.requestData.purpose));
            
            if (!hasMinimalData) {
              // Return a fallback card with guaranteed content when data is corrupted
              return (
                <View style={[styles.card, styles.responseCard]}>
                  <View style={styles.responseHeader}>
                    <View style={styles.responseBadge}>
                      <Text style={styles.responseBadgeText}>DONOR RESPONSE</Text>
                    </View>
                  </View>
                  <View style={styles.donorInfo}>
                    <Text style={{padding: 10, textAlign: 'center'}}>
                      Loading donor details...
                    </Text>
                  </View>
                </View>
              );
            }
            
            const donorName = ensureText(item.donorName, 'Anonymous Donor');
            const donorCity = ensureText(item.donorCity, '');
            const donorBloodGroup = ensureText(item.donorBloodGroup, '');
            const donorMobile = ensureText(item.donorMobile, '');
            const responseTime = ensureText(item.formattedResponseTime, 'Recently');
            const requestPurpose = ensureText(item.requestData?.purpose, 'Medical need');
            const requestCity = ensureText(item.requestData?.city, '');
            const requestHospital = ensureText(item.requestData?.hospital, '');
            const requestBloodGroup = ensureText(item.requestData?.bloodGroup, '');
            const requestUnits = ensureNumberText(item.requestData?.bloodUnits);
            const requiredTime = ensureText(item.requestData?.formattedRequiredTime, 'ASAP');
            const patientName = ensureText(item.requestData?.patientName, 'Your request');
            const patientContact = ensureText(item.requestData?.contactMobile, '');

            return (
            <View style={[
              styles.card,
              styles.responseCard,
              item.requestData?.status === 'completed' ? styles.completedCard :
              item.status === 'accepted' ? styles.acceptedCard : styles.declinedCard,
              item.isHighlighted && styles.highlightedCard,
              !item.seenByReceiver && styles.newCard
            ]}>
              <View style={styles.responseHeader}>
                <View style={[
                  styles.statusBadge,
                  item.requestData?.status === 'completed' ? styles.completedBadge :
                  item.status === 'accepted' ? styles.acceptedBadge : styles.declinedBadge
                ]}>
                  <Text style={styles.statusText}>
                    {item.requestData?.status === 'completed' ? 'COMPLETED' :
                     item.status === 'accepted' ? 'ACCEPTED' : 'DECLINED'}
                  </Text>
                </View>
                
                {!item.seenByReceiver && (
                  <View style={styles.newBadge}>
                    <Text style={styles.newBadgeText}>NEW</Text>
                  </View>
                )}
              </View>
              
              <View style={styles.requestSummary}>
                <Text style={styles.summaryTitle}>Your Request</Text>
                <Text style={styles.summaryDetail}>Patient: {patientName}</Text>
                <Text style={styles.summaryBloodType}>
                  {requestBloodGroup || 'N/A'} • {requestUnits} unit(s) • {requestCity || 'N/A'}
                </Text>
                <Text style={styles.summaryDetail}>
                  For: {requestPurpose}
                </Text>
                <Text style={styles.summaryDetail}>
                  By: {requiredTime}
                </Text>
                {requestHospital ? (
                  <Text style={styles.summaryDetail}>
                    At: {requestHospital}
                  </Text>
                ) : null}
                {patientContact ? (
                  <Text style={styles.summaryDetail}>
                    Contact: {patientContact}
                  </Text>
                ) : null}
              </View>
              
              <View style={styles.donorInfo}>
                <Text style={styles.donorTitle}>Donor Information</Text>
                <View style={styles.infoRow}>
                  <Text style={styles.donorLabel}>Name:</Text>
                  <Text style={styles.donorValue}>{donorName}</Text>
                </View>
                
                {donorBloodGroup ? (
                  <View style={styles.infoRow}>
                    <Text style={styles.donorLabel}>Blood Group:</Text>
                    <Text style={styles.bloodType}>{donorBloodGroup}</Text>
                  </View>
                ) : null}
                
                {donorCity ? (
                  <View style={styles.infoRow}>
                    <Text style={styles.donorLabel}>Location:</Text>
                    <Text style={styles.donorValue}>{donorCity}</Text>
                  </View>
                ) : null}
                
                {donorMobile && item.status === 'accepted' && (
                  <View style={styles.infoRow}>
                    <Text style={styles.donorLabel}>Contact:</Text>
                    <TouchableOpacity onPress={() => handlePhoneCall(donorMobile)}>
                      <Text style={styles.phoneValue}>{donorMobile}</Text>
                    </TouchableOpacity>
                  </View>
                )}
                
                <Text style={styles.responseTime}>
                  <Ionicons name="time-outline" size={12} color="#666" /> 
                  {responseTime}
                </Text>
              </View>
              
              {item.status === 'accepted' && donorMobile && item.requestData?.status !== 'completed' && (
                <TouchableOpacity 
                  style={styles.callButton}
                  onPress={() => handlePhoneCall(donorMobile)}
                >
                  <Ionicons name="call" size={16} color="#fff" />
                  <Text style={styles.callButtonText}>Call Donor</Text>
                </TouchableOpacity>
              )}
              {item.requestData?.status === 'completed' && (
                <View style={styles.completedNotice}>
                  <Ionicons name="checkmark-circle" size={20} color="#2e7d32" />
                  <Text style={styles.completedNoticeText}>Blood donation completed successfully!</Text>
                </View>
              )}
            </View>
            );
          }}
          refreshControl={
            <RefreshControl 
              refreshing={refreshing}
              onRefresh={handleRefresh}
              colors={['#b71c1c']}
            />
          }
          contentContainerStyle={styles.listContent}
          removeClippedSubviews={false}
          maxToRenderPerBatch={10}
          updateCellsBatchingPeriod={100}
          initialNumToRender={5}
          windowSize={10}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  headerTitle: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 18,
    color: '#333',
  },
  badge: {
    backgroundColor: '#b71c1c',
    borderRadius: 12,
    minWidth: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  badgeText: {
    color: '#fff',
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 12,
  },
  listContent: {
    padding: 16,
    paddingBottom: 100,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 8,
    marginBottom: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
    minHeight: 150,
    minWidth: '100%',
  },
  requestCard: {
    borderLeftWidth: 4,
    borderLeftColor: '#b71c1c',
  },
  responseCard: {
    borderLeftWidth: 4,
    minHeight: 150,
    backgroundColor: '#fff',
  },
  acceptedCard: {
    borderLeftColor: '#4caf50',
  },
  completedCard: {
    borderLeftColor: '#2e7d32',
    backgroundColor: '#f1f8f4',
  },
  declinedCard: {
    borderLeftColor: '#f44336',
  },
  highlightedCard: {
    borderWidth: 2,
    borderColor: '#ff9800',
    shadowColor: '#ff9800',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
  },
  newCard: {
    borderWidth: 2,
    borderColor: '#4caf50',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 8,
    backgroundColor: '#ffebee',
  },
  urgentBadge: {
    backgroundColor: '#b71c1c',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 4,
  },
  urgentText: {
    color: '#fff',
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 12,
  },
  newBadge: {
    backgroundColor: '#4caf50',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 4,
  },
  newBadgeText: {
    color: '#fff',
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 12,
  },
  requestInfo: {
    padding: 16,
  },
  infoRow: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  requestLabel: {
    fontFamily: 'Poppins_500Medium',
    fontSize: 14,
    color: '#555',
    width: 100,
  },
  requestValue: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 14,
    color: '#333',
    flex: 1,
  },
  bloodType: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 14,
    color: '#b71c1c',
  },
  urgentValue: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 14,
    color: '#b71c1c',
  },
  phoneValue: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 14,
    color: '#1976d2',
    textDecorationLine: 'underline',
  },
  timeInfo: {
    padding: 8,
    backgroundColor: '#f5f5f5',
    alignItems: 'center',
  },
  timeText: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 12,
    color: '#666',
  },
  actionButtons: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
  },
  actionButton: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
  acceptButton: {
    backgroundColor: '#4caf50',
  },
  declineButton: {
    backgroundColor: '#f44336',
  },
  actionButtonText: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 14,
    color: '#fff',
  },
  responseHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 8,
  },
  statusBadge: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 4,
  },
  acceptedBadge: {
    backgroundColor: '#e8f5e9',
  },
  completedBadge: {
    backgroundColor: '#c8e6c9',
  },
  declinedBadge: {
    backgroundColor: '#ffebee',
  },
  statusText: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 12,
    color: '#333',
  },
  requestSummary: {
    padding: 12,
    backgroundColor: '#f5f5f5',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  summaryTitle: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 14,
    color: '#333',
    marginBottom: 4,
  },
  summaryBloodType: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 14,
    color: '#b71c1c',
    marginBottom: 4,
  },
  summaryDetail: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 13,
    color: '#555',
    marginBottom: 2,
  },
  donorInfo: {
    padding: 16,
  },
  donorTitle: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 14,
    color: '#333',
    marginBottom: 8,
  },
  donorLabel: {
    fontFamily: 'Poppins_500Medium',
    fontSize: 14,
    color: '#555',
    width: 100,
  },
  donorValue: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 14,
    color: '#333',
    flex: 1,
  },
  responseTime: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 12,
    color: '#666',
    marginTop: 8,
  },
  callButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#4caf50',
    padding: 12,
    gap: 8,
  },
  callButtonText: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 14,
    color: '#fff',
  },
  completedNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#e8f5e9',
    padding: 12,
    gap: 8,
  },
  completedNoticeText: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 14,
    color: '#2e7d32',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  emptyText: {
    fontFamily: 'Poppins_500Medium',
    fontSize: 16,
    color: '#666',
    marginTop: 12,
  },
  emptySubtext: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 14,
    color: '#888',
    marginTop: 8,
    textAlign: 'center',
  },
  loadingText: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 16,
    color: '#666',
    marginTop: 16,
  },
  noProfileText: {
    fontFamily: 'Poppins_500Medium',
    fontSize: 16,
    color: '#666',
    marginTop: 12,
    marginBottom: 16,
  },
  setupButton: {
    backgroundColor: '#b71c1c',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 4,
  },
  setupButtonText: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 14,
    color: '#fff',
  },
  skeletonCard: {
    opacity: 0.9,
  },
  skeletonBadge: {
    height: 18,
    backgroundColor: '#f0f0f0',
    borderRadius: 4,
    marginBottom: 12,
  },
  skeletonBody: {
    gap: 8,
  },
  skeletonLine: {
    height: 12,
    backgroundColor: '#e0e0e0',
    borderRadius: 4,
    marginBottom: 6,
  },
  skeletonButtonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 16,
    gap: 12,
  },
  skeletonButton: {
    flex: 1,
    height: 36,
    backgroundColor: '#e0e0e0',
    borderRadius: 6,
  }
});
